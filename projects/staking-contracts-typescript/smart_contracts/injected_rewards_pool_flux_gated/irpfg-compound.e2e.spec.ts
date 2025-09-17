import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import * as algokit from "@algorandfoundation/algokit-utils";

import { IrpfgClient } from "../artifacts/injected_rewards_pool_flux_gated/irpfgClient";
import { Account } from "algosdk";
import { getStakingAccount, StakingAccount } from "./testing-utils";
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
    const previousAsaRewardIndex = globalStateBefore.currentAsaRewardIndex as bigint;

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
    expect(globalStateAfter.currentAsaRewardIndex).toBe(previousAsaRewardIndex + ASAInjectionAmount);
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
    for (var i = 0; i < numStakers; i++) {
      const staker = stakingAccounts[i];
      console.log("Unstaking for staker:", i, " address:", staker.account!.addr);
      appClient.algorand.setSignerFromAccount(staker.account!);

      const assetBalanceBeforeRequest = await appClient.algorand.client.algod
        .accountAssetInformation(staker.account!.addr, stakeAndRewardAssetId)
        .do();
      const assetBalanceBefore = assetBalanceBeforeRequest.assetHolding?.amount ?? 0n;
      console.log("assetBalanceBefore:", assetBalanceBefore);

      // Get stake and reward diffs prior to unstaking
      const stakerMap = await appClient.state.box.stakers.getMap();
      const stakeInfoBefore = stakerMap.get(staker.account!.addr.toString());
      console.log("staker info before unstaking:", stakeInfoBefore);
      expect(stakeInfoBefore).toBeDefined();
      const stakeBefore = stakeInfoBefore?.stake ?? 0n;
      expect(stakeBefore).toBeGreaterThan(0n);
      const lastRewardIndexBefore = stakeInfoBefore?.lastRewardIndex ?? 0n;
      expect(lastRewardIndexBefore).toBeDefined();
      const globalStateBefore = await appClient.state.global.getAll();
      const currentAsaRewardIndexBefore = globalStateBefore.currentAsaRewardIndex as bigint;
      expect(currentAsaRewardIndexBefore).toBeGreaterThan(0n);
      const stakeIndex = Number(numStakers) - i // stake index is reverse order to staker index
      const rewardDiff = (Number(currentAsaRewardIndexBefore) - Number(lastRewardIndexBefore)) / stakeIndex;

      const max_fee = 250_000;
      await appClient
        .newGroup()
        .unstake({ args: [0], sender: staker.account!.addr, maxFee: AlgoAmount.MicroAlgos(max_fee) })
        .send({ populateAppCallResources: true, suppressLog: false, coverAppCallInnerTransactionFees: true });

      const assetBalanceAfterRequest = await appClient.algorand.client.algod
        .accountAssetInformation(staker.account!.addr, stakeAndRewardAssetId)
        .do();
      const assetBalanceAfter = assetBalanceAfterRequest.assetHolding?.amount ?? 0n;

      expect(assetBalanceAfter).toBeGreaterThan(assetBalanceBefore);
      expect(assetBalanceAfter).toBeLessThanOrEqual(stakeBefore + assetBalanceBefore + BigInt(Math.floor(rewardDiff)));
      console.log("Unstaking complete - total unstaked (stake + rewards):", stakeBefore + assetBalanceBefore + BigInt(Math.floor(rewardDiff)));
      // Get stake and reward diffs prior to unstaking
      const stakerMapAfter = await appClient.state.box.stakers.getMap();
      const stakeInfoAfter = stakerMapAfter.get(staker.account!.addr.toString());
      expect(stakeInfoAfter).toBeUndefined();
    }
  }, 60000);

  test.skip("deleteApplication", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    await appClient
      .newGroup()

      .delete.deleteApplication()
      .send();
  });
});
