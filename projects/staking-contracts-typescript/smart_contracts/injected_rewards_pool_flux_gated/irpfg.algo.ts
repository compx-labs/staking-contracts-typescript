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
import { BOX_FEE, INITIAL_PAY_AMOUNT, mulDivW, PRECISION, StakeInfoRecord, STANDARD_TXN_FEE, VERSION } from "./config.algo";

@contract({ name: "irpfg", avmVersion: 11 })
export class InjectedRewardsPoolFluxGated extends Contract {
  //Global State

  stakers = BoxMap<Account, StakeInfoRecord>({ keyPrefix: "st" });

  staked_asset_id = GlobalState<UintN64>();

  reward_asset_id = GlobalState<UintN64>();

  total_staked = GlobalState<UintN64>();
  // lifetime tracking
  reward_per_token = GlobalState<UintN64>();

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
    this.reward_per_token.value = new UintN64(0);
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
    assert(quantity > 0, "Invalid reward quantity");
    assert(rewardAssetId === this.reward_asset_id.value.native, "Wrong reward asset");

    assertMatch(rewardTxn, {
      sender: this.admin_address.value,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.reward_asset_id.value.native),
      assetAmount: quantity,
    });
    assert(this.total_staked.value.native > 0, "No stakers");

    const deltaRPT = mulDivW(quantity, PRECISION, this.total_staked.value.native);
    this.reward_per_token.value = new UintN64(this.reward_per_token.value.native + deltaRPT);
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
        assetCloseTo: this.admin_address.value,
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
          assetCloseTo: this.admin_address.value,
          assetAmount: 0,
          assetReceiver: Global.currentApplicationAddress,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }
  }

  @abimethod({ allowActions: "NoOp" })
  stake(stakeTxn: gtxn.AssetTransferTxn, quantity: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(quantity > 0, "Invalid quantity");

    assertMatch(stakeTxn, {
      sender: op.Txn.sender,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.staked_asset_id.value.native),
      assetAmount: quantity,
    });

    const oracle: Application = this.flux_oracle_app.value;
    const result = abiCall(FluxGateStub.prototype.getUserTier, {
      appId: oracle.id,
      args: [new arc4.Address(op.Txn.sender)],
      sender: Global.currentApplicationAddress,
      fee: STANDARD_TXN_FEE,
      apps: [oracle],
      accounts: [op.Txn.sender],
    }).returnValue;
    assert(result.native >= this.flux_tier_required.value.native, "Insufficient flux tier");

    const exists = this.stakers(op.Txn.sender).exists;
    if (!exists) {
      assertMatch(mbrTxn, {
        sender: op.Txn.sender,
        receiver: Global.currentApplicationAddress,
        amount: BOX_FEE,
      });
    }

    const prevStake: uint64 = exists ? this.stakers(op.Txn.sender).value.stake.native : 0;
    const prevDebt: uint64 = exists ? this.stakers(op.Txn.sender).value.rewardDebt.native : 0;

    // 5) Calculate pending rewards with monotonic RPT
    //    pending = floor(prevStake * reward_per_token / PRECISION) - prevDebt
    const accrued = mulDivW(prevStake, this.reward_per_token.value.native, PRECISION);
    const pending: uint64 = accrued > prevDebt ? accrued - prevDebt : 0;

    // 6) If pending > 0, either compound (if same asset) or pay out (if different)
    let newStake: uint64 = prevStake;
    if (pending > 0) {
      if (this.staked_asset_id.value.native === this.reward_asset_id.value.native) {
        // Compound: add pending rewards into stake and total_staked
        newStake = newStake + pending;
        this.total_staked.value = new UintN64(this.total_staked.value.native + pending);
      } else {
        itxn
          .assetTransfer({
            xferAsset: this.reward_asset_id.value.native,
            assetReceiver: op.Txn.sender,
            sender: Global.currentApplicationAddress,
            assetAmount: pending,
            fee: STANDARD_TXN_FEE,
          })
          .submit();
      }
    }

    // 7) Add the new deposit
    newStake = newStake + quantity;
    this.total_staked.value = new UintN64(this.total_staked.value.native + quantity);

    // 8) Update user record (set rewardDebt to the new checkpoint)
    const newDebt = mulDivW(newStake, this.reward_per_token.value.native, PRECISION);
    this.stakers(op.Txn.sender).value = new StakeInfoRecord({
      stake: new UintN64(newStake),
      rewardDebt: new UintN64(newDebt),
    }).copy();

    if (!exists) {
      this.num_stakers.value = new UintN64(this.num_stakers.value.native + 1);
    }
  }

  @abimethod({ allowActions: "NoOp" })
  claimRewards(): void {
    // Must have a stake record
    assert(this.stakers(op.Txn.sender).exists, "No stake found for user");
    assert(this.staked_asset_id.value.native !== this.reward_asset_id.value.native, "Cannot claim rewards that compound");

    const staker = this.stakers(op.Txn.sender).value.copy();
    assert(staker.stake.native > 0, "No stake");

    // pending = floor(stake * reward_per_token / PRECISION) - rewardDebt
    const accrued = mulDivW(staker.stake.native, this.reward_per_token.value.native, PRECISION);
    const pending: uint64 = accrued > staker.rewardDebt.native ? accrued - staker.rewardDebt.native : 0;

    if (pending > 0) {
      itxn
        .assetTransfer({
          xferAsset: this.reward_asset_id.value.native,
          assetReceiver: op.Txn.sender,
          sender: Global.currentApplicationAddress,
          assetAmount: pending,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }

    const newDebt = mulDivW(staker.stake.native, this.reward_per_token.value.native, PRECISION);
    this.stakers(op.Txn.sender).value = new StakeInfoRecord({
      stake: staker.stake,
      rewardDebt: new UintN64(newDebt),
    }).copy();
  }

  @abimethod({ allowActions: "NoOp" })
  unstake(quantity: uint64): void {
    // 0) Must be an active staker
    assert(this.stakers(op.Txn.sender).exists, "No stake found for user");
    const rec = this.stakers(op.Txn.sender).value.copy();
    const stakeNow: uint64 = rec.stake.native;
    assert(stakeNow > 0, "No stake");

    const amountToWithdraw: uint64 = quantity === 0 ? stakeNow : quantity;
    assert(stakeNow >= amountToWithdraw, "Unstake amount exceeds balance");

    // 2) Settle pending rewards using monotonic accumulator
    //    pending = floor(stake * reward_per_token / PRECISION) - rewardDebt
    const accrued = mulDivW(stakeNow, this.reward_per_token.value.native, PRECISION);
    const pending: uint64 = accrued > rec.rewardDebt.native ? accrued - rec.rewardDebt.native : 0;

    if (pending > 0) {
      // Always pay out rewards on unstake (even if same asset) for clarity
      itxn
        .assetTransfer({
          xferAsset: this.reward_asset_id.value.native,
          assetReceiver: op.Txn.sender,
          sender: Global.currentApplicationAddress,
          assetAmount: pending,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    }

    // 3) Return staked tokens
    itxn
      .assetTransfer({
        xferAsset: this.staked_asset_id.value.native,
        assetReceiver: op.Txn.sender,
        sender: Global.currentApplicationAddress,
        assetAmount: amountToWithdraw,
        fee: STANDARD_TXN_FEE,
      })
      .submit();

    // 4) Update pool total
    this.total_staked.value = new UintN64(this.total_staked.value.native - amountToWithdraw);

    // 5) Update (or delete) user record
    const remaining: uint64 = stakeNow - amountToWithdraw;
    if (remaining === 0) {
      // Full exit
      this.stakers(op.Txn.sender).delete();
      this.num_stakers.value = new UintN64(this.num_stakers.value.native - 1);
      //Repay unlocked MBR from box
      itxn
        .payment({
          receiver: op.Txn.sender,
          amount: BOX_FEE - 2000,
          sender: Global.currentApplicationAddress,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
    } else {
      // Partial exit: refresh rewardDebt to new checkpoint
      const newDebt = mulDivW(remaining, this.reward_per_token.value.native, PRECISION);
      this.stakers(op.Txn.sender).value = new StakeInfoRecord({
        stake: new UintN64(remaining),
        rewardDebt: new UintN64(newDebt),
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
