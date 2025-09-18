import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import * as algokit from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { Account } from "algosdk";

import { IrpfgClient } from "../artifacts/injected_rewards_pool_flux_gated/irpfgClient";
import { FluxGateClient } from "./flux-gateClient";
import { deploy } from "./deploy";
import { mulDivFloor } from "./testing-utils";

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

let appClient: IrpfgClient;
let admin: Account;
let stakeAndRewardAssetId: bigint;
let fluxOracleAppId: bigint = 20695n;

export const PRECISION = 1_000_000_000_000_000n; // 1e15
const BOX_FEE = 22_500n;

// micro stakes (ASA has 6 dp): total = 6 micro-units
const u1 = 1n, u2 = 2n, u3 = 3n;
const microStake = [u1, u2, u3];

type MicroStaker = { account: Account; stake: bigint };
let microStakers: MicroStaker[] = [];

describe("Micro precision (COMPOUNDING: staked ASA == reward ASA, no claimRewards)", () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;
    const { generateAccount } = fixture.context;

    admin = await generateAccount({ initialFunds: algokit.microAlgo(4_000_000_000) });
    appClient = await deploy(admin);

    await algokit.ensureFunded(
      {
        accountToFund: admin,
        fundingSource: await algokit.getDispenserAccount(algorand.client.algod, algorand.client.kmd!),
        minSpendingBalance: algokit.algos(50),
      },
      algorand.client.algod
    );

    // single ASA for BOTH stake & rewards (compounding)
    const token = algorand.send.assetCreate({
      sender: admin.addr, total: 999_999_999_000n, decimals: 6, assetName: "Stake+Reward",
    });
    stakeAndRewardAssetId = BigInt((await token).confirmation.assetIndex!);

    const initialBalanceTxn = await fixture.algorand.createTransaction.payment({
      sender: admin.addr, receiver: appClient.appAddress, amount: algokit.microAlgos(400_000),
    });

    await appClient.send.initApplication({
      args: [stakeAndRewardAssetId, stakeAndRewardAssetId, initialBalanceTxn, 1n, fluxOracleAppId],
    });

    // prepare 3 micro stakers & stake
    for (const amt of microStake) {
      const account = await generateAccount({ initialFunds: algokit.algos(2), suppressLog: true });
      microStakers.push({ account, stake: amt });

      await algorand.send.assetTransfer({ assetId: stakeAndRewardAssetId, amount: 0n, sender: account.addr, receiver: account.addr, suppressLog: true });
      await algorand.send.assetTransfer({ assetId: stakeAndRewardAssetId, amount: 20n, sender: admin.addr, receiver: account.addr, suppressLog: true });

      const fg = new FluxGateClient({ algorand, appId: fluxOracleAppId });
      fg.algorand.setSignerFromAccount(admin);
      await fg.send.setUserTier({
        args: [account.addr.toString(), 1n],
        sender: admin.addr,
        populateAppCallResources: true,
        suppressLog: true,
      });

      appClient.algorand.setSignerFromAccount(account);
      algorand.setSignerFromAccount(account);

      const stakeTxn = await algorand.createTransaction.assetTransfer({
        assetId: stakeAndRewardAssetId, amount: amt, sender: account.addr, receiver: appClient.appAddress,
        maxFee: AlgoAmount.MicroAlgos(250_000),
      });
      const mbrTxn = await algorand.createTransaction.payment({
        sender: account.addr, receiver: appClient.appAddress, amount: AlgoAmount.MicroAlgos(BOX_FEE),
        maxFee: AlgoAmount.MicroAlgos(250_000),
      });

      await appClient.newGroup()
        .stake({ args: [stakeTxn, amt, mbrTxn], sender: account.addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
        .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });
    }
  });

  test("tiny injection floors RPT delta; RPT only changes on inject", async () => {
    const gs0 = await appClient.state.global.getAll();
    expect(BigInt(gs0.totalStaked as bigint)).toBe(6n);

    const injectAmt = 7n; // not divisible by 6
    const deltaExpected = mulDivFloor(injectAmt, PRECISION, 6n);

    const axferTxn = await fixture.algorand.createTransaction.assetTransfer({
      sender: admin.addr, receiver: appClient.appAddress, assetId: stakeAndRewardAssetId, amount: injectAmt,
    });

    const rptBefore = BigInt(gs0.rewardPerToken as bigint);
    appClient.algorand.setSignerFromAccount(admin);
    await appClient.send.injectRewards({
      args: [axferTxn, injectAmt, stakeAndRewardAssetId],
      assetReferences: [stakeAndRewardAssetId],
      populateAppCallResources: true,
    });

    const gs1 = await appClient.state.global.getAll();
    expect(BigInt(gs1.rewardPerToken as bigint)).toBe(rptBefore + deltaExpected);
  });

  test("stake() compounds pending precisely; wallet only debited by new deposit", async () => {
    // choose the 2-micro staker
    const s = microStakers.find(x => x.stake === 2n)!;
    const addr = s.account.addr;

    const map0 = await appClient.state.box.stakers.getMap();
    const rec0 = map0.get(addr.toString())!;

    const gs0 = await appClient.state.global.getAll();
    const rpt = BigInt(gs0.rewardPerToken as bigint);
    const totalBefore = BigInt(gs0.totalStaked as bigint);

    const stakeBefore = BigInt(rec0.stake);
    const debtBefore  = BigInt(rec0.rewardDebt);
    const accrued = mulDivFloor(stakeBefore, rpt, PRECISION);
    const pending = accrued > debtBefore ? (accrued - debtBefore) : 0n;

    // user wallet before
    const balBeforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
    const balBefore = BigInt(balBeforeReq.assetHolding?.amount ?? 0n);

    // deposit d=5 micro to trigger compounding
    const d = 5n;
    appClient.algorand.setSignerFromAccount(s.account);

    const stakeTxn = await fixture.algorand.createTransaction.assetTransfer({
      assetId: stakeAndRewardAssetId, amount: d, sender: addr, receiver: appClient.appAddress,
      maxFee: AlgoAmount.MicroAlgos(250_000),
    });
    const mbrTxn = await fixture.algorand.createTransaction.payment({
      sender: addr, receiver: appClient.appAddress, amount: AlgoAmount.MicroAlgos(0),
      maxFee: AlgoAmount.MicroAlgos(250_000),
    });

    await appClient.newGroup()
      .stake({ args: [stakeTxn, d, mbrTxn], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
      .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

    const map1 = await appClient.state.box.stakers.getMap();
    const rec1 = map1.get(addr.toString())!;
    const stakeAfter = BigInt(rec1.stake);
    const debtAfter  = BigInt(rec1.rewardDebt);

    // compounding math
    expect(stakeAfter).toBe(stakeBefore + d + pending);

    const gs1 = await appClient.state.global.getAll();
    expect(BigInt(gs1.totalStaked as bigint)).toBe(totalBefore + d + pending);
    expect(BigInt(gs1.rewardPerToken as bigint)).toBe(rpt); // unchanged on stake

    // wallet only debited by d (pending stayed on-chain as stake)
    const balAfterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
    const balAfter = BigInt(balAfterReq.assetHolding?.amount ?? 0n);
    expect(balBefore - balAfter).toBe(d);

    // checkpoint debt = floor(stakeAfter * rpt / PRECISION)
    const chk = mulDivFloor(stakeAfter, rpt, PRECISION);
    expect(debtAfter).toBe(chk);
  });

  test("partial unstake pays principal+pending (same ASA); RPT unchanged", async () => {
    // pick the 3-micro staker
    const s = microStakers.find(x => x.stake === 3n)!;
    const addr = s.account.addr;

    const map0 = await appClient.state.box.stakers.getMap();
    const rec0 = map0.get(addr.toString())!;

    const gs0 = await appClient.state.global.getAll();
    const rpt0 = BigInt(gs0.rewardPerToken as bigint);
    const total0 = BigInt(gs0.totalStaked as bigint);

    const stakeBefore = BigInt(rec0.stake);
    const debtBefore  = BigInt(rec0.rewardDebt);
    const accrued = mulDivFloor(stakeBefore, rpt0, PRECISION);
    const pending = accrued > debtBefore ? (accrued - debtBefore) : 0n;

    // wallet before
    const balBeforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
    const balBefore = BigInt(balBeforeReq.assetHolding?.amount ?? 0n);

    // withdraw amount a = 5 micro-units (if user has that much; otherwise use 1n)
    const a = stakeBefore >= 5n ? 5n : 1n;

    appClient.algorand.setSignerFromAccount(s.account);
    await appClient.newGroup()
      .unstake({ args: [a], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
      .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

    // wallet delta = principal withdrawn + ALL pending at time of unstake
    const balAfterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
    const balAfter = BigInt(balAfterReq.assetHolding?.amount ?? 0n);
    expect(balAfter - balBefore).toBe(a + pending);

    // pool totals & debt
    const gs1 = await appClient.state.global.getAll();
    expect(BigInt(gs1.rewardPerToken as bigint)).toBe(rpt0);
    expect(BigInt(gs1.totalStaked as bigint)).toBe(total0 - a);

    const map1 = await appClient.state.box.stakers.getMap();
    const rec1 = map1.get(addr.toString())!;
    const remaining = stakeBefore - a;
    const debtAfter = BigInt(rec1.rewardDebt);
    const chk = mulDivFloor(remaining, rpt0, PRECISION);
    expect(debtAfter).toBe(chk);
  });

  test("full exit for all users: sum(reward part) ≤ total injected", async () => {
    // Do several tiny injections to create rounding pressure
    const injects = [5n, 4n, 3n, 2n, 1n]; // sum = 15
    let totalInjected = 0n;

    for (const amt of injects) {
      const axferTxn = await fixture.algorand.createTransaction.assetTransfer({
        sender: admin.addr, receiver: appClient.appAddress, assetId: stakeAndRewardAssetId, amount: amt,
      });
      appClient.algorand.setSignerFromAccount(admin);
      await appClient.send.injectRewards({
        args: [axferTxn, amt, stakeAndRewardAssetId],
        assetReferences: [stakeAndRewardAssetId],
        populateAppCallResources: true,
      });
      totalInjected += amt;
    }

    // Now fully unstake everyone; measure only the "reward part" by subtracting principal
    let sumRewardPaid = 0n;

    for (const s of microStakers) {
      const addr = s.account.addr;

      const map0 = await appClient.state.box.stakers.getMap();
      const rec0 = map0.get(addr.toString());
      if (!rec0) continue; // user may have exited already

      const stakeNow = BigInt(rec0.stake);
      const gs = await appClient.state.global.getAll();
      const rpt = BigInt(gs.rewardPerToken as bigint);

      const debt = BigInt(rec0.rewardDebt);
      const accrued = mulDivFloor(stakeNow, rpt, PRECISION);
      const pending = accrued > debt ? (accrued - debt) : 0n;

      // wallet before
      const balBeforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
      const balBefore = BigInt(balBeforeReq.assetHolding?.amount ?? 0n);

      appClient.algorand.setSignerFromAccount(s.account);
      await appClient.newGroup()
        .unstake({ args: [0], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
        .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

      const balAfterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakeAndRewardAssetId)).do();
      const balAfter = BigInt(balAfterReq.assetHolding?.amount ?? 0n);

      // delta = principal + pending; reward part is delta - principal
      const delta = balAfter - balBefore;
      const rewardPart = delta - stakeNow;
      expect(rewardPart).toBe(pending); // exact at exit
      sumRewardPaid += rewardPart;
    }

    // Flooring guarantee: total reward paid out across users ≤ total injected
    expect(sumRewardPaid).toBeLessThanOrEqual(totalInjected);
  });
});
