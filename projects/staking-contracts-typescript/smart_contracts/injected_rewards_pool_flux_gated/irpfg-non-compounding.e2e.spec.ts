import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import * as algokit from "@algorandfoundation/algokit-utils";

import { IrpfgClient } from "../artifacts/injected_rewards_pool_flux_gated/irpfgClient";
import { Account } from "algosdk";
import { mulDivFloor, StakingAccount } from "./testing-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { deploy } from "./deploy";
import { FluxGateClient } from "./flux-gateClient";

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

let appClient: IrpfgClient;
let fluxOracleAppId: bigint = 20695n;
let admin: Account;
let stakedAssetId: bigint;     // CHANGED: separate ids
let rewardAssetId: bigint;     // CHANGED: separate ids
let ASAInjectionAmount = 10n * 10n ** 6n;
export const PRECISION = 1_000_000_000_000_000n;
const FLUX_TIER_REQUIRED = 1;

const BOX_FEE = 22_500n;
const numStakers = 4n;
let stakingAccounts: StakingAccount[] = [];
let stakerWithWrongTier: StakingAccount;

describe("Injected Reward Pool - non-compounding (separate reward ASA)", () => {
  beforeEach(fixture.beforeEach);

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;
    const { generateAccount } = fixture.context;
    admin = await generateAccount({ initialFunds: algokit.microAlgo(6_000_000_000) });

    appClient = await deploy(admin);
    await algokit.ensureFunded(
      {
        accountToFund: admin,
        fundingSource: await algokit.getDispenserAccount(algorand.client.algod, algorand.client.kmd!),
        minSpendingBalance: algokit.algos(100),
      },
      algorand.client.algod
    );

    // CHANGED: create two distinct ASAs
    const stakedToken = algorand.send.assetCreate({
      sender: admin.addr,
      total: 999_999_999_000n,
      decimals: 6,
      assetName: "Stake Token",
    });
    stakedAssetId = BigInt((await stakedToken).confirmation.assetIndex!);

    const rewardToken = algorand.send.assetCreate({
      sender: admin.addr,
      total: 999_999_999_000n,
      decimals: 6,
      assetName: "Reward Token",
    });
    rewardAssetId = BigInt((await rewardToken).confirmation.assetIndex!);

    const initialBalanceTxn = await fixture.algorand.createTransaction.payment({
      sender: admin.addr,
      receiver: appClient.appAddress,
      amount: algokit.microAlgos(400_000),
    });

    // CHANGED: init with stakedAssetId + rewardAssetId (different)
    await appClient.send.initApplication({
      args: [stakedAssetId, rewardAssetId, initialBalanceTxn, 1n, fluxOracleAppId],
    });
  });

  test("confirm global state on initialisation", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    const globalState = await appClient.state.global.getAll();
    expect(globalState.stakedAssetId).toBe(stakedAssetId);
    expect(globalState.rewardAssetId).toBe(rewardAssetId); // CHANGED
    expect(globalState.lastRewardInjectionTime).toBe(0n);
  });

  test("inject rewards ASA with no stake - expect fail ", async () => {
    const { algorand } = fixture;

    const axferTxn = await algorand.createTransaction.assetTransfer({
      sender: admin.addr,
      receiver: appClient.appAddress,
      assetId: rewardAssetId,                     // CHANGED
      amount: ASAInjectionAmount,
    });

    appClient.algorand.setSignerFromAccount(admin);
    await expect(
      appClient.send.injectRewards({
        args: [axferTxn, ASAInjectionAmount, rewardAssetId],  // CHANGED
        assetReferences: [rewardAssetId],                     // CHANGED
        populateAppCallResources: true,
      })
    ).rejects.toThrow();
  });

  test("init stakers", async () => {
    const { algorand } = fixture;
    algorand.setSignerFromAccount(admin);
    for (var x = 0; x < numStakers; x++) {
      const account = await fixture.context.generateAccount({ initialFunds: algokit.algos(10), suppressLog: true });
      const staker = {
        account: account,
        stake: 10n * 10n ** 6n,
      };

      // Opt-in to both ASAs
      await algorand.send.assetTransfer({
        assetId: stakedAssetId,
        amount: 0n,
        sender: staker.account.addr,
        receiver: staker.account.addr,
        suppressLog: true,
      });
      await algorand.send.assetTransfer({
        assetId: rewardAssetId, // CHANGED: also opt-in reward asset for later payouts
        amount: 0n,
        sender: staker.account.addr,
        receiver: staker.account.addr,
        suppressLog: true,
      });

      // Fund stake to user
      await algorand.send.assetTransfer({
        assetId: stakedAssetId,
        amount: staker.stake * 2n,
        sender: admin.addr,
        receiver: staker.account.addr,
        suppressLog: true,
      });

      // Flux oracle: set tier >= required
      const fluxGateClient = new FluxGateClient({ algorand, appId: BigInt(fluxOracleAppId) });
      fluxGateClient.algorand.setSignerFromAccount(admin);
      await fluxGateClient.send.setUserTier({
        args: [staker.account.addr.toString(), 1n],
        sender: admin.addr,
        populateAppCallResources: true,
        suppressLog: true,
      });

      stakingAccounts.push(staker);
    }
  }, 600000);

  test("staking", async () => {
    const { algorand } = fixture;

    for (var staker of stakingAccounts) {
      // Check tier
      const fluxGateClient = new FluxGateClient({ algorand, appId: BigInt(fluxOracleAppId), defaultSender: admin.addr });
      fluxGateClient.algorand.setSignerFromAccount(admin);
      const userTier = await fluxGateClient.send.getUserTier({ args: { user: staker.account!.addr.toString() } });
      expect(userTier.return).toBe(1n);

      const stakerBalanceRequest = await algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(stakedAssetId)).do();
      expect(BigInt(stakerBalanceRequest.assetHolding?.amount ?? 0n)).toBeGreaterThan(0n);

      appClient.algorand.setSignerFromAccount(staker.account!);
      algorand.setSignerFromAccount(staker.account!);
      const stakeTxn = await algorand.createTransaction.assetTransfer({
        assetId: stakedAssetId, // CHANGED
        amount: staker.stake,
        sender: staker.account!.addr,
        receiver: appClient.appAddress,
        maxFee: AlgoAmount.MicroAlgos(250_000),
      });
      const mbrTxn = await algorand.createTransaction.payment({
        sender: staker.account!.addr,
        receiver: appClient.appAddress,
        amount: AlgoAmount.MicroAlgos(BOX_FEE),
        maxFee: AlgoAmount.MicroAlgos(250_000),
      });

      await appClient
        .newGroup()
        .stake({ args: [stakeTxn, staker.stake, mbrTxn], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
        .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });
    }
  }, 60000);

  test("staker 1 stakes again - 0-value MBR is accepted", async () => {
    const { algorand } = fixture;
    const staker = stakingAccounts[1];
    appClient.algorand.setSignerFromAccount(staker.account!);
    algorand.setSignerFromAccount(staker.account!);

    const stakeTxn = await algorand.createTransaction.assetTransfer({
      assetId: stakedAssetId, // CHANGED
      amount: staker.stake,
      sender: staker.account!.addr,
      receiver: appClient.appAddress,
      maxFee: AlgoAmount.MicroAlgos(250_000),
    });
    const mbrTxn = await algorand.createTransaction.payment({
      sender: staker.account!.addr,
      receiver: appClient.appAddress,
      amount: AlgoAmount.MicroAlgos(0), // one-time MBR only
      maxFee: AlgoAmount.MicroAlgos(250_000),
    });

    await appClient
      .newGroup()
      .stake({ args: [stakeTxn, staker.stake, mbrTxn], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
      .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });
  }, 60000);
});

test("create staker with insufficient tier and stake - expect fail", async () => {
  const { algorand } = fixture;
  algorand.setSignerFromAccount(admin);
  const account = await fixture.context.generateAccount({ initialFunds: algokit.algos(10), suppressLog: true });
  const staker = { account, stake: 10n * 10n ** 6n };

  // opt-ins
  await algorand.send.assetTransfer({ assetId: stakedAssetId, amount: 0n, sender: staker.account.addr, receiver: staker.account.addr, suppressLog: true });
  await algorand.send.assetTransfer({ assetId: rewardAssetId, amount: 0n, sender: staker.account.addr, receiver: staker.account.addr, suppressLog: true });

  // fund stake
  await algorand.send.assetTransfer({ assetId: stakedAssetId, amount: staker.stake, sender: admin.addr, receiver: staker.account.addr, suppressLog: true });

  const fluxGateClient = new FluxGateClient({ algorand, appId: BigInt(fluxOracleAppId) });
  fluxGateClient.algorand.setSignerFromAccount(admin);
  await fluxGateClient.send.setUserTier({
    args: [staker.account.addr.toString(), 0n],
    sender: admin.addr,
    populateAppCallResources: true,
    suppressLog: true,
  });

  const stakeTxn = await algorand.createTransaction.assetTransfer({
    assetId: stakedAssetId, // CHANGED
    amount: staker.stake,
    sender: staker.account!.addr,
    receiver: appClient.appAddress,
    maxFee: AlgoAmount.MicroAlgos(250_000),
  });
  const mbrTxn = await algorand.createTransaction.payment({
    sender: staker.account!.addr,
    receiver: appClient.appAddress,
    amount: AlgoAmount.MicroAlgos(BOX_FEE),
    maxFee: AlgoAmount.MicroAlgos(250_000),
  });

  appClient.algorand.setSignerFromAccount(staker.account!);
  algorand.setSignerFromAccount(staker.account!);
  await expect(
    appClient
      .newGroup()
      .stake({ args: [stakeTxn, staker.stake, mbrTxn], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(250_000) })
      .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true })
  ).rejects.toThrow();
});

test("inject rewards ASA", async () => {
  const { algorand } = fixture;
  const globalStateBefore = await appClient.state.global.getAll();
  const previousRewardPerToken = globalStateBefore.rewardPerToken as bigint;

  const axferTxn = await algorand.createTransaction.assetTransfer({
    sender: admin.addr,
    receiver: appClient.appAddress,
    assetId: rewardAssetId, // CHANGED
    amount: ASAInjectionAmount,
  });

  appClient.algorand.setSignerFromAccount(admin);
  await appClient.send.injectRewards({
    args: [axferTxn, ASAInjectionAmount, rewardAssetId], // CHANGED
    assetReferences: [rewardAssetId],                    // CHANGED
    populateAppCallResources: true,
  });

  const gsAfter = await appClient.state.global.getAll();
  const totalStakeAfter = gsAfter.totalStaked as bigint;
  const deltaRPT = (ASAInjectionAmount * PRECISION) / totalStakeAfter;
  const newRewardPerToken = previousRewardPerToken + deltaRPT;
  expect(gsAfter.rewardPerToken).toBe(newRewardPerToken);
});

test("inject incorrect reward asset - expect fail", async () => {
  const { algorand } = fixture;
  algorand.setSignerFromAccount(admin);
  const fakeAsset = await algorand.send.assetCreate({
    sender: admin.addr,
    total: 100_000_000n,
    decimals: 6,
    assetName: "Fake Reward Token",
  });
  const fakeAssetId = fakeAsset.confirmation.assetIndex!;

  const axferTxn = await algorand.createTransaction.assetTransfer({
    sender: admin.addr,
    receiver: appClient.appAddress,
    assetId: fakeAssetId,
    amount: ASAInjectionAmount,
  });

  appClient.algorand.setSignerFromAccount(admin);
  await expect(
    appClient.send.injectRewards({
      args: [axferTxn, ASAInjectionAmount, fakeAssetId],
      assetReferences: [fakeAssetId],
      populateAppCallResources: true,
      sender: admin.addr,
    })
  ).rejects.toThrow();
});

test("attempt to unstake more than staked", async () => {
  const staker = stakingAccounts[0];
  appClient.algorand.setSignerFromAccount(staker.account!);
  const max_fee = 250_000;
  await expect(
    appClient
      .newGroup()
      .unstake({ args: [staker.stake + 1n], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(max_fee) })
      .send({ populateAppCallResources: true, suppressLog: true, coverAppCallInnerTransactionFees: true })
  ).rejects.toThrow();
}, 60000);

test("partial unstake pays pending rewards (separate reward ASA) and updates rewardDebt", async () => {
  // read ids
  const gs0 = await appClient.state.global.getAll();
  const stakedId = gs0.stakedAssetId as bigint;
  const rewardId = gs0.rewardAssetId as bigint;

  const staker = stakingAccounts[1];
  appClient.algorand.setSignerFromAccount(staker.account!);

  // balances before
  const stakeBalBeforeReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(stakedId)).do();
  const stakeBalBefore = BigInt(stakeBalBeforeReq.assetHolding?.amount ?? 0n);
  const rewardBalBeforeReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(rewardId)).do();
  const rewardBalBefore = BigInt(rewardBalBeforeReq.assetHolding?.amount ?? 0n);

  // staker state before
  const stakerMap = await appClient.state.box.stakers.getMap();
  const recBefore = stakerMap.get(staker.account!.addr.toString());
  expect(recBefore).toBeDefined();

  const stakeBefore = BigInt(recBefore?.stake ?? 0n);
  const rewardDebtBefore = BigInt(recBefore?.rewardDebt ?? 0n);
  expect(stakeBefore).toBeGreaterThan(0n);

  // globals before
  const gs1 = await appClient.state.global.getAll();
  const rptBefore = BigInt(gs1.rewardPerToken as bigint);
  const totalStakedBefore = BigInt(gs1.totalStaked as bigint);

  // expected pending
  const accrued = mulDivFloor(stakeBefore, rptBefore, PRECISION);
  const pending = accrued > rewardDebtBefore ? accrued - rewardDebtBefore : 0n;

  // partial unstake
  const amount = 5n * 10n ** 6n;
  const max_fee = 250_000;
  await appClient
    .newGroup()
    .unstake({ args: [amount], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(max_fee) })
    .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });

  // balances after
  const stakeBalAfterReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(stakedId)).do();
  const stakeBalAfter = BigInt(stakeBalAfterReq.assetHolding?.amount ?? 0n);
  const rewardBalAfterReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(rewardId)).do();
  const rewardBalAfter = BigInt(rewardBalAfterReq.assetHolding?.amount ?? 0n);

  // staker state after
  const stakerMapAfter = await appClient.state.box.stakers.getMap();
  const recAfter = stakerMapAfter.get(staker.account!.addr.toString());
  expect(recAfter).toBeDefined();

  const stakeAfter = BigInt(recAfter?.stake ?? 0n);
  const rewardDebtAfter = BigInt(recAfter?.rewardDebt ?? 0n);
  expect(stakeAfter).toBe(stakeBefore - amount);

  // checkpoint debt
  const accruedAfter = mulDivFloor(stakeAfter, rptBefore, PRECISION);
  expect(rewardDebtAfter).toBe(accruedAfter);

  // globals invariant
  const gs2 = await appClient.state.global.getAll();
  expect(BigInt(gs2.rewardPerToken as bigint)).toBe(rptBefore);
  expect(BigInt(gs2.totalStaked as bigint)).toBe(totalStakedBefore - amount);

  // balances assertions (non-compounding)
  const deltaStake = stakeBalAfter - stakeBalBefore;
  const deltaReward = rewardBalAfter - rewardBalBefore;
  expect(deltaStake).toBe(amount);      // principal back only
  expect(deltaReward).toBe(pending);    // rewards paid separately
}, 60_000);

test("unstake all pays stake (staked ASA) + pending (reward ASA)", async () => {
  const gs = await appClient.state.global.getAll();
  const stakedId = gs.stakedAssetId as bigint;
  const rewardId = gs.rewardAssetId as bigint;

  for (let i = 0; i < numStakers; i++) {
    const staker = stakingAccounts[i];
    appClient.algorand.setSignerFromAccount(staker.account!);

    // balances before
    const stakeBalBeforeReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(stakedId)).do();
    const stakeBalBefore = BigInt(stakeBalBeforeReq.assetHolding?.amount ?? 0);
    const rewardBalBeforeReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(rewardId)).do();
    const rewardBalBefore = BigInt(rewardBalBeforeReq.assetHolding?.amount ?? 0);

    // staker state before
    const stakerMap = await appClient.state.box.stakers.getMap();
    const recBefore = stakerMap.get(staker.account!.addr.toString());
    expect(recBefore).toBeDefined();
    const stakeBefore = BigInt(recBefore?.stake ?? 0n);
    const rewardDebtBefore = BigInt(recBefore?.rewardDebt ?? 0n);
    expect(stakeBefore).toBeGreaterThan(0n);

    // global accumulator
    const gs2 = await appClient.state.global.getAll();
    const rewardPerToken = BigInt(gs2.rewardPerToken as bigint);

    const accrued = mulDivFloor(stakeBefore, rewardPerToken, PRECISION);
    const pending = accrued > rewardDebtBefore ? accrued - rewardDebtBefore : 0n;

    // unstake all
    const max_fee = 250_000;
    await appClient
      .newGroup()
      .unstake({ args: [0], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(max_fee) })
      .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });

    // balances after
    const stakeBalAfterReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(stakedId)).do();
    const stakeBalAfter = BigInt(stakeBalAfterReq.assetHolding?.amount ?? 0);
    const rewardBalAfterReq = await appClient.algorand.client.algod.accountAssetInformation(staker.account!.addr, Number(rewardId)).do();
    const rewardBalAfter = BigInt(rewardBalAfterReq.assetHolding?.amount ?? 0);

    const deltaStakeAsset = stakeBalAfter - stakeBalBefore;
    const deltaRewardAsset = rewardBalAfter - rewardBalBefore;

    expect(deltaStakeAsset).toBe(stakeBefore);   // principal back
    expect(deltaRewardAsset).toBe(pending);      // rewards paid separately

    // box deleted
    const stakerMapAfter = await appClient.state.box.stakers.getMap();
    const recAfter = stakerMapAfter.get(staker.account!.addr.toString());
    expect(recAfter).toBeUndefined();
  }
}, 60_000);

test.skip("deleteApplication", async () => {
  appClient.algorand.setSignerFromAccount(admin);
  await appClient.newGroup().delete.deleteApplication().send();
});
