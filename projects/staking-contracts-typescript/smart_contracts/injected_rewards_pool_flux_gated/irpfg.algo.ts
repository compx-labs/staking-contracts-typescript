import {
  Account,
  Application,
  arc4,
  assert,
  assertMatch,
  Asset,
  BoxMap,
  contract,
  Contract,
  err,
  GlobalState,
  gtxn,
  itxn,
  op,
  uint64,
} from "@algorandfoundation/algorand-typescript";
import { abiCall, abimethod, Address, UintN64, UintN8 } from "@algorandfoundation/algorand-typescript/arc4";
import { Global } from "@algorandfoundation/algorand-typescript/op";
import { INITIAL_PAY_AMOUNT, mulDivW, PRECISION, StakeInfoRecord, STANDARD_TXN_FEE, VERSION } from "./config.algo";

@contract({ name: "irpfg", avmVersion: 11 })
export class InjectedRewardsPoolFluxGated extends Contract {
  //Global State

  stakers = BoxMap<Account, StakeInfoRecord>({ keyPrefix: "st" });

  staked_asset_id = GlobalState<UintN64>();

  reward_asset_id = GlobalState<UintN64>();

  total_staked = GlobalState<UintN64>();
  // lifetime tracking
  current_asa_reward_index = GlobalState<UintN64>();

  last_reward_injection_time = GlobalState<UintN64>();

  admin_address = GlobalState<Account>();

  num_stakers = GlobalState<UintN64>();

  contract_version = GlobalState<UintN64>();

  flux_tier_required = GlobalState<UintN8>();

  flux_oracle_app = GlobalState<Application>();

  @abimethod({ allowActions: "NoOp", onCreate: "require" })
  createApplication(adminAddress: Address): void {
    this.admin_address.value = adminAddress.native;
    this.contract_version.value = new UintN64(VERSION);
  }
  /**
   * Initializes the staking pool application with the specified staked asset and reward asset.
   *
   * Sets up global state variables, verifies the initial funding payment, and opts the contract into the staked asset
   * and reward asset if necesary.
   * Only the admin address can call this function.
   *
   * @param stakedAssetId - The asset ID of the token to be staked in the pool.
   * @param rewardAssetId - The asset ID of the token to be distributed as rewards.
   * @param initialBalanceTxn - The payment transaction providing the initial minimum balance for the contract.
   */
  @abimethod({ allowActions: "NoOp" })
  initApplication(
    stakedAssetId: uint64,
    rewardAssetId: uint64,
    initialBalanceTxn: gtxn.PaymentTxn,
    fluxTierRequired: uint64,
    fluxOracleApp: Application
  ): void {
    assert(op.Txn.sender === this.admin_address.value, "Only admin can init application");

    this.staked_asset_id.value = new UintN64(stakedAssetId);
    this.reward_asset_id.value = new UintN64(rewardAssetId);
    this.total_staked.value = new UintN64(0);
    this.last_reward_injection_time.value = new UintN64(0);
    this.current_asa_reward_index.value = new UintN64(0);
    this.num_stakers.value = new UintN64(0);
    this.flux_tier_required.value = new UintN8(fluxTierRequired);
    this.flux_oracle_app.value = fluxOracleApp;

    assertMatch(initialBalanceTxn, {
      receiver: Global.currentApplicationAddress,
      amount: INITIAL_PAY_AMOUNT,
    });

    itxn
      .assetTransfer({
        xferAsset: stakedAssetId,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: 0,
        fee: STANDARD_TXN_FEE,
      })
      .submit();
    if (rewardAssetId !== stakedAssetId) {
      itxn
        .assetTransfer({
          xferAsset: rewardAssetId,
          assetReceiver: Global.currentApplicationAddress,
          assetAmount: 0,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }
  }
  //ADMIN FUNCTIONS
  @abimethod({ allowActions: "NoOp" })
  updateAdminAddress(adminAddress: Account): void {
    assert(op.Txn.sender === this.admin_address.value, "Only admin can update admin address");
    this.admin_address.value = adminAddress;
  }

  /*
   * Inject rewards into the pool
   */
  @abimethod({ allowActions: "NoOp" })
  injectRewards(rewardTxn: gtxn.AssetTransferTxn, quantity: uint64, rewardAssetId: uint64): void {
    assert(op.Txn.sender === this.admin_address.value, "Only admin can inject rewards");

    assertMatch(rewardTxn, {
      sender: this.admin_address.value,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(rewardAssetId),
      assetAmount: quantity,
    });
    this.current_asa_reward_index.value = new UintN64(this.current_asa_reward_index.value.native + quantity);
    this.last_reward_injection_time.value = new UintN64(Global.latestTimestamp);
  }

  @abimethod({ allowActions: "DeleteApplication" })
  deleteApplication(): void {
    assert(op.Txn.sender === this.admin_address.value, "Only admin can delete application");
    assert(this.total_staked.value.native === 0, "Staked assets still exist");

    // opt out of tokens
    itxn
      .assetTransfer({
        xferAsset: this.staked_asset_id.value.native,
        assetCloseTo: Global.zeroAddress,
        assetAmount: 0,
        assetReceiver: Global.currentApplicationAddress,
        fee: STANDARD_TXN_FEE,
      })
      .submit();
    // opt out of reward token
    if (this.staked_asset_id.value !== this.reward_asset_id.value) {
      itxn
        .assetTransfer({
          xferAsset: this.reward_asset_id.value.native,
          assetCloseTo: Global.zeroAddress,
          assetAmount: 0,
          assetReceiver: Global.currentApplicationAddress,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }
  }

  @abimethod({ allowActions: "NoOp" })
  stake(stakeTxn: gtxn.AssetTransferTxn, quantity: uint64): void {
    assert(quantity > 0, "Invalid quantity");

    assertMatch(stakeTxn, {
      sender: op.Txn.sender,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.staked_asset_id.value.native),
      assetAmount: quantity,
    });

    const oracle: Application = this.flux_oracle_app.value;
    const address = oracle.address;
    const contractAppId = oracle.id;

    // Check users flux tier against oracle contract
    const result = abiCall(FluxGateStub.prototype.getUserTier, {
      appId: contractAppId,
      args: [new arc4.Address(op.Txn.sender)],
      sender: Global.currentApplicationAddress,
      fee: STANDARD_TXN_FEE,
      apps: [oracle],
      accounts: [op.Txn.sender],
    }).returnValue;

    assert(result.native >= this.flux_tier_required.value.native, "Insufficient flux tier");

    const hasLoan = this.stakers(op.Txn.sender).exists;

    if (hasLoan) {
      const newStake = new UintN64(this.stakers(op.Txn.sender).value.stake.native + stakeTxn.assetAmount);
      this.stakers(op.Txn.sender).value = new StakeInfoRecord({
        stake: newStake,
        lastRewardIndex: this.stakers(op.Txn.sender).value.lastRewardIndex,
      }).copy();
      this.total_staked.value = new UintN64(this.total_staked.value.native + stakeTxn.assetAmount);
    } else {
      this.stakers(op.Txn.sender).value = new StakeInfoRecord({
        stake: new UintN64(stakeTxn.assetAmount),
        lastRewardIndex: this.current_asa_reward_index.value,
      }).copy();

      this.num_stakers.value = new UintN64(this.num_stakers.value.native + 1);
      this.total_staked.value = new UintN64(this.total_staked.value.native + stakeTxn.assetAmount);
    }
  }

  @abimethod({ allowActions: "NoOp" })
  claimRewards(): void {
    assert(this.stakers(op.Txn.sender).exists, "No stake found for user");

    const staker = this.stakers(op.Txn.sender).value.copy();

    assert(staker.stake.native > 0, "No stake");

    // Calculate rewards base on user reward index and current reward index diff
    const rewardIndexDiff: uint64 = this.current_asa_reward_index.value.native - staker.lastRewardIndex.native;
    let shareOfTotalStake = mulDivW(staker.stake.native, PRECISION, this.total_staked.value.native);
    let shareOfRewards = mulDivW(rewardIndexDiff, shareOfTotalStake, PRECISION);

    if (shareOfRewards > 0) {
      itxn
        .assetTransfer({
          xferAsset: this.reward_asset_id.value.native,
          assetReceiver: op.Txn.sender,
          sender: Global.currentApplicationAddress,
          assetAmount: shareOfRewards,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }
    this.stakers(op.Txn.sender).value = new StakeInfoRecord({
      stake: staker.stake,
      lastRewardIndex: this.current_asa_reward_index.value,
    }).copy();
  }

  @abimethod({ allowActions: "NoOp" })
  unstake(quantity: uint64): void {
    assert(this.stakers(op.Txn.sender).exists, "No stake found for user");
    const currentRecord = this.stakers(op.Txn.sender).value.copy();
    assert(currentRecord.stake.native > 0, "No stake");

    assert(currentRecord.stake.native >= quantity);

    itxn
      .assetTransfer({
        xferAsset: this.staked_asset_id.value.native,
        assetReceiver: op.Txn.sender,
        sender: Global.currentApplicationAddress,
        assetAmount: quantity === 0 ? currentRecord.stake.native : quantity,
        fee: STANDARD_TXN_FEE,
      })
      .submit();

    //check other rewards
    if (currentRecord.lastRewardIndex !== this.current_asa_reward_index.value) {
      //Check for rewards to be claimed
      const rewardIndexDiff: uint64 = this.current_asa_reward_index.value.native - currentRecord.lastRewardIndex.native;
      let shareOfTotalStake = mulDivW(currentRecord.stake.native, PRECISION, this.total_staked.value.native);
      let shareOfRewards = mulDivW(rewardIndexDiff, shareOfTotalStake, PRECISION);

      if (shareOfRewards > 0) {
        itxn
          .assetTransfer({
            xferAsset: this.reward_asset_id.value.native,
            assetReceiver: op.Txn.sender,
            sender: Global.currentApplicationAddress,
            assetAmount: shareOfRewards,
            fee: STANDARD_TXN_FEE,
          })
          .submit();
      }
    }

    // Update the total staked value
    this.total_staked.value = new UintN64(this.total_staked.value.native - (quantity === 0 ? currentRecord.stake.native : quantity));
    if (quantity === 0) {
      this.stakers(op.Txn.sender).delete();
      this.num_stakers.value = new UintN64(this.num_stakers.value.native - 1);
    } else {
      this.stakers(op.Txn.sender).value = new StakeInfoRecord({
        stake: new UintN64(currentRecord.stake.native - quantity),
        lastRewardIndex: this.current_asa_reward_index.value,
      }).copy();
    }
  }

  @abimethod({ allowActions: "NoOp" })
  gas(): void {}
}
export abstract class FluxGateStub extends Contract {
  @abimethod({ allowActions: "NoOp" })
  getUserTier(user: arc4.Address): UintN64 {
    err("stub only");
  }
}
