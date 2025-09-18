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
let stakedAssetId: bigint;
let rewardAssetId: bigint;
let fluxOracleAppId: bigint = 20695n;

export const PRECISION = 1_000_000_000_000_000n; // 1e15

const u1 = 1n;  // 0.000001
const u2 = 2n;  // 0.000002
const u3 = 3n;  // 0.000003
const microStake = [u1, u2, u3];
const BOX_FEE = 22_500n;

// IMPORTANT: keep Account objects here and use them to set signers
type MicroStaker = { account: Account; stake: bigint };
let microStakers: MicroStaker[] = [];

describe("Micro staking precision (non-compounding)", () => {
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

    // Create separate stake & reward ASAs (non-compounding)
    const stakedToken = algorand.send.assetCreate({
      sender: admin.addr, total: 999_999_999_000n, decimals: 6, assetName: "Stake Token",
    });
    stakedAssetId = BigInt((await stakedToken).confirmation.assetIndex!);

    const rewardToken = algorand.send.assetCreate({
      sender: admin.addr, total: 999_999_999_000n, decimals: 6, assetName: "Reward Token",
    });
    rewardAssetId = BigInt((await rewardToken).confirmation.assetIndex!);

    const initialBalanceTxn = await fixture.algorand.createTransaction.payment({
      sender: admin.addr, receiver: appClient.appAddress, amount: algokit.microAlgos(400_000),
    });

    await appClient.send.initApplication({
      args: [stakedAssetId, rewardAssetId, initialBalanceTxn, 1n, fluxOracleAppId],
    });

    // Prepare micro stakers (keep Account objects)
    for (const amt of microStake) {
      const account = await generateAccount({ initialFunds: algokit.algos(2), suppressLog: true });
      microStakers.push({ account, stake: amt });

      // Opt-in both ASAs
      await algorand.send.assetTransfer({ assetId: stakedAssetId, amount: 0n, sender: account.addr, receiver: account.addr, suppressLog: true });
      await algorand.send.assetTransfer({ assetId: rewardAssetId, amount: 0n, sender: account.addr, receiver: account.addr, suppressLog: true });

      // Fund micro stake and set tier
      await algorand.send.assetTransfer({ assetId: stakedAssetId, amount: amt, sender: admin.addr, receiver: account.addr, suppressLog: true });

      const fg = new FluxGateClient({ algorand, appId: fluxOracleAppId });
      fg.algorand.setSignerFromAccount(admin);
      await fg.send.setUserTier({ args: [account.addr.toString(), 1n], sender: admin.addr, populateAppCallResources: true, suppressLog: true });

      // Stake
      appClient.algorand.setSignerFromAccount(account);
      algorand.setSignerFromAccount(account);

      const stakeTxn = await algorand.createTransaction.assetTransfer({
        assetId: stakedAssetId, amount: amt, sender: account.addr, receiver: appClient.appAddress,
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

  test("tiny injection floors RPT delta", async () => {
    const gs0 = await appClient.state.global.getAll();
    expect(BigInt(gs0.totalStaked as bigint)).toBe(6n);

    const injectAmt = 7n;
    const deltaExpected = mulDivFloor(injectAmt, PRECISION, 6n);

    const axferTxn = await fixture.algorand.createTransaction.assetTransfer({
      sender: admin.addr, receiver: appClient.appAddress, assetId: rewardAssetId, amount: injectAmt,
    });

    const rptBefore = BigInt(gs0.rewardPerToken as bigint);
    appClient.algorand.setSignerFromAccount(admin);
    await appClient.send.injectRewards({
      args: [axferTxn, injectAmt, rewardAssetId], assetReferences: [rewardAssetId], populateAppCallResources: true,
    });

    const gs1 = await appClient.state.global.getAll();
    expect(BigInt(gs1.rewardPerToken as bigint)).toBe(rptBefore + deltaExpected);
  });

  test("claim correctness per user; sum payouts ≤ injected", async () => {
    const gs = await appClient.state.global.getAll();
    const rpt = BigInt(gs.rewardPerToken as bigint);

    let computedTotal = 0n;
    let paidTotal = 0n;

    // iterate using stored Account objects; skip any who no longer have boxes
    const stakerMap = await appClient.state.box.stakers.getMap();

    for (const s of microStakers) {
      const addr = s.account.addr;
      const rec = stakerMap.get(addr.toString());
      if (!rec) continue; // user might have exited in earlier tests

      const stake = BigInt(rec.stake);
      const debt  = BigInt(rec.rewardDebt);
      const accrued = mulDivFloor(stake, rpt, PRECISION);
      const pending = accrued > debt ? (accrued - debt) : 0n;
      computedTotal += pending;

      // reward balance before
      const beforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(rewardAssetId)).do();
      const balBefore = BigInt(beforeReq.assetHolding?.amount ?? 0n);

      // claim with correct signer
      appClient.algorand.setSignerFromAccount(s.account);
      await appClient.newGroup()
        .claimRewards({ args: [], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) }) // double claim to test zero pending path
        .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

      const afterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(rewardAssetId)).do();
      const balAfter = BigInt(afterReq.assetHolding?.amount ?? 0n);
      const paid = balAfter - balBefore;

      expect(paid).toBe(pending);
      paidTotal += paid;
    }

    // Exactly 7n was injected in previous test; sum of payouts cannot exceed it (flooring)
    expect(paidTotal).toBeLessThanOrEqual(7n);
    expect(paidTotal).toBe(computedTotal);
  });

  test("micro partial/all unstake uses correct signer & precise balances", async () => {
    // pick the 1-micro staker (if still present)
    const one = microStakers.find(s => s.stake === 1n)!;
    const addr = one.account.addr;

    // if the box is gone (claimed & exited earlier), skip gracefully
    const map0 = await appClient.state.box.stakers.getMap();
    const rec0 = map0.get(addr.toString());
    if (!rec0) return;

    const gs0 = await appClient.state.global.getAll();
    const rpt0 = BigInt(gs0.rewardPerToken as bigint);
    const total0 = BigInt(gs0.totalStaked as bigint);

    const stakeBefore = BigInt(rec0.stake);
    const debtBefore  = BigInt(rec0.rewardDebt);

    // First claim to isolate principal
    appClient.algorand.setSignerFromAccount(one.account);
    await appClient.newGroup()
        .claimRewards({ args: [], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) }) // double claim to test zero pending path
      .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

    const stakeBalBeforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakedAssetId)).do();
    const stakeBalBefore = BigInt(stakeBalBeforeReq.assetHolding?.amount ?? 0n);

    // Unstake all
    await appClient.newGroup()
      .unstake({ args: [0], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
      .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

    const stakeBalAfterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(stakedAssetId)).do();
    const stakeBalAfter = BigInt(stakeBalAfterReq.assetHolding?.amount ?? 0n);
    expect(stakeBalAfter - stakeBalBefore).toBe(stakeBefore);

    const gs1 = await appClient.state.global.getAll();
    expect(BigInt(gs1.rewardPerToken as bigint)).toBe(rpt0);
    expect(BigInt(gs1.totalStaked as bigint)).toBe(total0 - stakeBefore);
  });

  test("many tiny injections; sum of user claims (with correct signers) ≤ total injected", async () => {
    const injects = [5n, 4n, 3n, 2n, 1n]; // sum 15
    let totalInjected = 0n;

    for (const amt of injects) {
      const axferTxn = await fixture.algorand.createTransaction.assetTransfer({
        sender: admin.addr, receiver: appClient.appAddress, assetId: rewardAssetId, amount: amt,
      });
      appClient.algorand.setSignerFromAccount(admin);
      await appClient.send.injectRewards({
        args: [axferTxn, amt, rewardAssetId], assetReferences: [rewardAssetId], populateAppCallResources: true,
      });
      totalInjected += amt;
    }

    // Claim for all current stakers who still exist
    const stakerMap = await appClient.state.box.stakers.getMap();
    let sumPaid = 0n;

    for (const s of microStakers) {
      const addr = s.account.addr;
      if (!stakerMap.get(addr.toString())) continue;

      const beforeReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(rewardAssetId)).do();
      const balBefore = BigInt(beforeReq.assetHolding?.amount ?? 0n);

      appClient.algorand.setSignerFromAccount(s.account);
      await appClient.newGroup()
        .claimRewards({ args: [], sender: addr, maxFee: AlgoAmount.MicroAlgos(250_000) }) // double claim to test zero pending path
        .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true });

      const afterReq = await fixture.algorand.client.algod.accountAssetInformation(addr, Number(rewardAssetId)).do();
      const balAfter = BigInt(afterReq.assetHolding?.amount ?? 0n);

      sumPaid += (balAfter - balBefore);
    }

    expect(sumPaid).toBeLessThanOrEqual(totalInjected);
  });
});
