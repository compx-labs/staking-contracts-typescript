import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import * as algokit from "@algorandfoundation/algokit-utils";

import { IrpfgClient } from "../artifacts/injected_rewards_pool_flux_gated/irpfgClient";
import { Account } from "algosdk";
import { getStakingAccount, mulDivFloor, StakingAccount } from "./testing-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { deploy, getFluxGateClient } from "./deploy";
import { FluxGateClient } from "./flux-gateClient";

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

let appClient: IrpfgClient;
let fluxOracleAppId: bigint = 20695n;
let admin: Account;
let stakeAndRewardAssetId: bigint;
let ASAInjectionAmount = 10n * 10n ** 6n;
const BYTE_LENGTH_STAKER = 48;
export const PRECISION = 1_000_000_000_000_000n;

const BOX_FEE = 22_500n;
const numStakers = 10n;
let stakingAccounts: StakingAccount[] = [];

describe("Injected Reward Pool - 50x stakers test", () => {
  beforeEach(fixture.beforeEach);

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { testAccount } = fixture.context;
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

    const stakeAndRewardToken = algorand.send.assetCreate({
      sender: admin.addr,
      total: 999_999_999_000n,
      decimals: 6,
      assetName: "Stake Token",
    });
    stakeAndRewardAssetId = BigInt((await stakeAndRewardToken).confirmation.assetIndex!);

    const initialBalanceTxn = await fixture.algorand.createTransaction.payment({
      sender: admin.addr,
      receiver: appClient.appAddress,
      amount: algokit.microAlgos(400_000),
    });

    await appClient.send.initApplication({
      args: [stakeAndRewardAssetId, stakeAndRewardAssetId, initialBalanceTxn, 1n, fluxOracleAppId],
    });
  });

  test("confirm global state on initialisation", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    const globalState = await appClient.state.global.getAll();
    expect(globalState.stakedAssetId).toBe(stakeAndRewardAssetId);
    expect(globalState.rewardAssetId).toBe(stakeAndRewardAssetId);
    expect(globalState.lastRewardInjectionTime).toBe(0n);
  });

  test("inject rewards ASA with no stake - expect fail ", async () => {
    const { algorand } = fixture;

    const axferTxn = await algorand.createTransaction.assetTransfer({
      sender: admin.addr,
      receiver: appClient.appAddress,
      assetId: stakeAndRewardAssetId,
      amount: ASAInjectionAmount,
    });

    appClient.algorand.setSignerFromAccount(admin);
    await expect(
      appClient.send.injectRewards({
        args: [axferTxn, ASAInjectionAmount, stakeAndRewardAssetId],
        assetReferences: [stakeAndRewardAssetId],
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

      await algorand.send.assetTransfer({
        assetId: stakeAndRewardAssetId,
        amount: 0n,
        sender: staker.account.addr,
        receiver: staker.account.addr,
        suppressLog: true,
      });
      await algorand.send.assetTransfer({
        assetId: stakeAndRewardAssetId,
        amount: staker.stake,
        sender: admin.addr,
        receiver: staker.account.addr,
        suppressLog: true,
      });

      // Add to flux gate oracle
      const fluxGateClient = new FluxGateClient({
        algorand, // your AlgorandClient instance
        appId: BigInt(fluxOracleAppId), // the application ID
      });
      fluxGateClient.algorand.setSignerFromAccount(admin);

      await fluxGateClient.send.setUserTier({
        args: [staker.account.addr.toString(), 1n],
        sender: admin.addr,
        populateAppCallResources: true,
        suppressLog: true,
      });

      stakingAccounts.push(staker);
      //console.log('new staker created number ', x)
    }
  }, 600000);

  test("staking", async () => {
    const { algorand } = fixture;

    for (var staker of stakingAccounts) {
      // Check user tier externally
      const fluxGateClient = new FluxGateClient({
        algorand, // your AlgorandClient instance
        appId: BigInt(fluxOracleAppId), // the application ID
        defaultSender: admin.addr,
      });
      fluxGateClient.algorand.setSignerFromAccount(admin);
      const userTier = await fluxGateClient.send.getUserTier({
        args: { user: staker.account!.addr.toString() },
      });
      console.log("userTier:", userTier.return);
      expect(userTier.return).toBe(1n);

      const stakerBalanceRequest = await algorand.client.algod.accountAssetInformation(staker.account!.addr, stakeAndRewardAssetId).do();
      expect(stakerBalanceRequest.assetHolding?.amount).toBeGreaterThan(0n);
      appClient.algorand.setSignerFromAccount(staker.account!);
      algorand.setSignerFromAccount(staker.account!);
      const stakeTxn = await algorand.createTransaction.assetTransfer({
        assetId: stakeAndRewardAssetId,
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

  test("inject rewards ASA ", async () => {
    const { algorand } = fixture;
    const globalStateBefore = await appClient.state.global.getAll();
    const previousRewardPerToken = globalStateBefore.rewardPerToken as bigint;

    const axferTxn = await algorand.createTransaction.assetTransfer({
      sender: admin.addr,
      receiver: appClient.appAddress,
      assetId: stakeAndRewardAssetId,
      amount: ASAInjectionAmount,
    });

    appClient.algorand.setSignerFromAccount(admin);
    await appClient.send.injectRewards({
      args: [axferTxn, ASAInjectionAmount, stakeAndRewardAssetId],
      assetReferences: [stakeAndRewardAssetId],
      populateAppCallResources: true,
    });

    const globalStateAfter = await appClient.state.global.getAll();
    const totalStakeAfter = globalStateAfter.totalStaked as bigint;
    const deltaRPT = (ASAInjectionAmount * PRECISION) / totalStakeAfter;
    const newRewardPerToken = previousRewardPerToken + deltaRPT;
    expect(globalStateAfter.rewardPerToken).toBe(newRewardPerToken);
  });

  test.skip("attempt to unstake more than staked", async () => {
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

  test("unstake all", async () => {
    // read global ids once
    const gs = await appClient.state.global.getAll();
    const stakedAssetId = gs.stakedAssetId as bigint;
    const rewardAssetId = gs.rewardAssetId as bigint;
    const sameAsset = stakedAssetId === rewardAssetId;

    for (let i = 0; i < numStakers; i++) {
      const staker = stakingAccounts[i];
      appClient.algorand.setSignerFromAccount(staker.account!);

      // --- balances before ---
      const stakeBalBeforeReq = await appClient.algorand.client.algod
        .accountAssetInformation(staker.account!.addr, Number(stakedAssetId))
        .do();
      const stakeBalBefore = BigInt(stakeBalBeforeReq.assetHolding?.amount ?? 0);

      let rewardBalBefore = 0n;
      if (!sameAsset) {
        const rewardBalBeforeReq = await appClient.algorand.client.algod
          .accountAssetInformation(staker.account!.addr, Number(rewardAssetId))
          .do();
        rewardBalBefore = BigInt(rewardBalBeforeReq.assetHolding?.amount ?? 0);
      }

      // --- staker state before ---
      const stakerMap = await appClient.state.box.stakers.getMap();
      const recBefore = stakerMap.get(staker.account!.addr.toString());
      expect(recBefore).toBeDefined();
      const stakeBefore = BigInt(recBefore?.stake ?? 0n);
      const rewardDebtBefore = BigInt(recBefore?.rewardDebt ?? 0n);
      expect(stakeBefore).toBeGreaterThan(0n);

      // --- global accumulator ---
      const gs2 = await appClient.state.global.getAll();
      const rewardPerToken = BigInt(gs2.rewardPerToken as bigint);
      expect(rewardPerToken).toBeGreaterThanOrEqual(0n);

      // --- expected pending by monotonic model ---
      const accrued = mulDivFloor(stakeBefore, rewardPerToken, PRECISION);
      const pending = accrued > rewardDebtBefore ? accrued - rewardDebtBefore : 0n;

      // --- perform unstake all (quantity = 0) ---
      const max_fee = 250_000;
      await appClient
        .newGroup()
        .unstake({ args: [0], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(max_fee) })
        .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });

      // --- balances after ---
      const stakeBalAfterReq = await appClient.algorand.client.algod
        .accountAssetInformation(staker.account!.addr, Number(stakedAssetId))
        .do();
      const stakeBalAfter = BigInt(stakeBalAfterReq.assetHolding?.amount ?? 0);

      let rewardBalAfter = 0n;
      if (!sameAsset) {
        const rewardBalAfterReq = await appClient.algorand.client.algod
          .accountAssetInformation(staker.account!.addr, Number(rewardAssetId))
          .do();
        rewardBalAfter = BigInt(rewardBalAfterReq.assetHolding?.amount ?? 0);
      }

      // --- assertions ---
      if (sameAsset) {
        // User receives stake + pending in the same ASA
        const deltaStakeAsset = stakeBalAfter - stakeBalBefore;
        expect(deltaStakeAsset).toBeGreaterThanOrEqual(stakeBefore); // got at least the principal back
        expect(deltaStakeAsset).toBe(stakeBefore + pending); // exactly principal + pending
      } else {
        // Stake asset increases by stake; reward asset increases by pending
        const deltaStakeAsset = stakeBalAfter - stakeBalBefore;
        const deltaRewardAsset = rewardBalAfter - rewardBalBefore;

        expect(deltaStakeAsset).toBe(stakeBefore);
        // pending can be zero in edge cases; just assert non-negative and exact match
        expect(deltaRewardAsset).toBe(pending);
      }

      // Staker box should be removed after full exit
      const stakerMapAfter = await appClient.state.box.stakers.getMap();
      const recAfter = stakerMapAfter.get(staker.account!.addr.toString());
      expect(recAfter).toBeUndefined();
    }
  }, 60_000);

  test.skip("deleteApplication", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    await appClient
      .newGroup()

      .delete.deleteApplication()
      .send();
  });
});
