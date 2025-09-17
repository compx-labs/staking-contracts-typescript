import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import * as algokit from "@algorandfoundation/algokit-utils";

import { IrpfgClient } from "../artifacts/injected_rewards_pool_flux_gated/irpfgClient";
import { Account } from "algosdk";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { deploy } from "./deploy";

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

let appClient: IrpfgClient;
let fluxOracleId: bigint = 17907n;
let admin: Account;
let stakeAndRewardAssetId: bigint;
const BYTE_LENGTH_REWARD_ASSET = 8;
const MIN_FEE = AlgoAmount.MicroAlgos(250_000);
const FLUX_TIER_REQUIRED = 1;

describe("Injected Reward Pool setup/admin functions - no staking", () => {
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
      args: [stakeAndRewardAssetId, stakeAndRewardAssetId, initialBalanceTxn, FLUX_TIER_REQUIRED, fluxOracleId],
    });
  });

  test("confirm global state on initialisation", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    const globalState = await appClient.state.global.getAll();
    expect(globalState.stakedAssetId).toBe(stakeAndRewardAssetId);
    expect(globalState.rewardAssetId).toBe(stakeAndRewardAssetId);
    expect(globalState.lastRewardInjectionTime).toBe(0n);
    expect(globalState.fluxOracleApp).toBe(fluxOracleId);
    expect(globalState.fluxTierRequired).toBe(FLUX_TIER_REQUIRED);
  });


  test("deleteApplication", async () => {
    appClient.algorand.setSignerFromAccount(admin);
    await appClient
      .newGroup()
      .delete.deleteApplication()
      .send();
  });
});
