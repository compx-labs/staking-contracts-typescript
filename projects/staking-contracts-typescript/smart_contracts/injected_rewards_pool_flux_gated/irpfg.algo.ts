import {
  Account,
  Application,
  arc4,
  assert,
  assertMatch,
  Asset,
  Box,
  contract,
  Contract,
  ensureBudget,
  err,
  GlobalState,
  gtxn,
  itxn,
  op,
  uint64,
} from "@algorandfoundation/algorand-typescript";
import { abiCall, abimethod, Address, StaticArray, UintN64, UintN8 } from "@algorandfoundation/algorand-typescript/arc4";
import { Global } from "@algorandfoundation/algorand-typescript/op";
import {
  ALGORAND_ACCOUNT_MIN_BALANCE,
  ASSET_HOLDING_FEE,
  INITIAL_PAY_AMOUNT,
  MAX_STAKERS_PER_POOL,
  mbrReturn,
  mulDivW,
  PRECISION,
  StakeInfo,
  STANDARD_TXN_FEE,
  VERSION,
} from "./config.algo";

@contract({ name: "irpfg", avmVersion: 11 })
export class InjectedRewardsPoolFluxGated extends Contract {
  //Global State

  stakers = Box<StaticArray<StakeInfo, 650>>({ key: "stakers" });

  staked_asset_id = GlobalState<UintN64>();

  reward_asset_id = GlobalState<UintN64>();

  total_staked = GlobalState<UintN64>();

  injected_asa_rewards = GlobalState<UintN64>();

  last_reward_injection_time = GlobalState<UintN64>();

  last_accrual_time = GlobalState<UintN64>();

  admin_address = GlobalState<Account>();

  minimum_balance = GlobalState<UintN64>();

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
    this.injected_asa_rewards.value = new UintN64(0);
    this.num_stakers.value = new UintN64(0);
    this.flux_tier_required.value = new UintN8(fluxTierRequired);
    this.flux_oracle_app.value = fluxOracleApp

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

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    const SCBOX_PERBOX: uint64 = 2500;
    const SCBOX_PERBYTE: uint64 = 400;

    return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE;
  }

  @abimethod({ allowActions: "NoOp" })
  getMBRForPoolCreation(): mbrReturn {
    let nonAlgoRewardMBR: uint64 = 0;
    if (this.reward_asset_id.value.native !== 0) {
      nonAlgoRewardMBR += ASSET_HOLDING_FEE;
    }
    const mbr: uint64 =
      ALGORAND_ACCOUNT_MIN_BALANCE +
      nonAlgoRewardMBR +
      this.costForBoxStorage(7 + 48 * MAX_STAKERS_PER_POOL) +
      this.costForBoxStorage(7 + 8 * 15);

    return {
      mbrPayment: mbr,
    };
  }

  @abimethod({ allowActions: "NoOp" })
  initStorage(mbrPayment: gtxn.PaymentTxn): void {
    assert(!this.stakers.exists, "staking pool already initialized");
    assert(op.Txn.sender === this.admin_address.value, "Only admin can init storage");

    let nonAlgoRewardMBR: uint64 = 0;
    if (this.reward_asset_id.value.native !== 0) {
      nonAlgoRewardMBR += ASSET_HOLDING_FEE;
    }
    const poolMBR: uint64 =
      ALGORAND_ACCOUNT_MIN_BALANCE +
      nonAlgoRewardMBR +
      this.costForBoxStorage(7 + 48 * MAX_STAKERS_PER_POOL) +
      this.costForBoxStorage(7 + 8 * 15);

    // the pay transaction must exactly match our MBR requirement.
    assertMatch(mbrPayment, { receiver: Global.currentApplicationAddress, amount: poolMBR });
    this.stakers.create();
    this.minimum_balance.value = new UintN64(poolMBR);
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
    this.injected_asa_rewards.value = new UintN64(this.injected_asa_rewards.value.native + quantity);
    this.last_reward_injection_time.value = new UintN64(Global.latestTimestamp);
  }

  @abimethod({ allowActions: "DeleteApplication" })
  deleteApplication(): void {
    assert(op.Txn.sender === this.admin_address.value, "Only admin can delete application");
    assert(this.total_staked.value.native === 0, "Staked assets still exist");

    this.stakers.delete();

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

    /* sendPayment({
      amount: this.app.address.balance - Global.minBalance - 2000,
      receiver: this.adminAddress.value,
      sender: this.app.address,
      fee: STANDARD_TXN_FEE,
    }); */
  }
  @abimethod({ allowActions: "NoOp" })
  stake(stakeTxn: gtxn.AssetTransferTxn, quantity: uint64): void {
    const currentTimeStamp = Global.latestTimestamp;
    assert(quantity > 0, "Invalid quantity");

   const oracle: Application = this.flux_oracle_app.value
    const address = oracle.address
    const contractAppId = oracle.id

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

    if (Global.opcodeBudget < 300) {
      ensureBudget(Global.opcodeBudget + 700);
    }
    assertMatch(stakeTxn, {
      sender: op.Txn.sender,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.staked_asset_id.value.native),
      assetAmount: quantity,
    });
    let actionComplete: boolean = false;
    if (Global.opcodeBudget < 300) {
      ensureBudget(Global.opcodeBudget + 700);
    }
    for (let i: uint64 = 0; i < this.stakers.value.length; i += 1) {
      if (actionComplete) break;

      if (this.stakers.value[i].account === new arc4.Address(op.Txn.sender)) {
        //adding to current stake
        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }

        const staker = this.stakers.value[i].copy();
        staker.stake = new UintN64(staker.stake.native + stakeTxn.assetAmount);

        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }
        this.stakers.value[i] = staker.copy();
        this.total_staked.value = new UintN64(this.total_staked.value.native + stakeTxn.assetAmount);
        actionComplete = true;
      } else if (this.stakers.value[i].account === new arc4.Address(Global.zeroAddress)) {
        // New staker
        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }
        this.total_staked.value = new UintN64(this.total_staked.value.native + stakeTxn.assetAmount);
        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }
        this.stakers.value[i] = new StakeInfo({
          account: new arc4.Address(op.Txn.sender),
          stake: new UintN64(stakeTxn.assetAmount),
          accruedASARewards: new UintN64(0),
        }).copy();
        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }
        this.num_stakers.value = new UintN64(this.num_stakers.value.native + 1);
        actionComplete = true;
      } else {
        // pool is full return assert
        assert(this.num_stakers.value.native < MAX_STAKERS_PER_POOL, "Max stakers limit reached");
      }

      if (Global.opcodeBudget < 300) {
        ensureBudget(Global.opcodeBudget + 700);
      }
    }
    assert(actionComplete, "Stake  failed");
  }

  @abimethod({ allowActions: "NoOp" })
  accrueRewards(): void {
    if (this.injected_asa_rewards.value.native * 2 > this.num_stakers.value.native) {
      const additionalASARewards = this.injected_asa_rewards.value;

      for (let i: uint64 = 0; i < this.num_stakers.value.native; i += 1) {
        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }

        if (this.stakers.value[i].stake.native > 0) {
          const staker = this.stakers.value[i].copy();

          //let stakerShare = wideRatio([staker.stake, PRECISION], [this.total_staked.value]);
          let stakerShare = mulDivW(staker.stake.native, PRECISION, this.total_staked.value.native);

          if (Global.opcodeBudget < 300) {
            ensureBudget(Global.opcodeBudget + 700);
          }

          if (additionalASARewards.native > 0) {
            //let rewardRate = wideRatio([additionalASARewards, stakerShare], [PRECISION]);
            let rewardRate = mulDivW(additionalASARewards.native, stakerShare, PRECISION);
            if (rewardRate === 0) {
              rewardRate = 1;
            }

            if (this.injected_asa_rewards.value.native >= rewardRate) {
              this.injected_asa_rewards.value = new UintN64(this.injected_asa_rewards.value.native - rewardRate);

              if (this.reward_asset_id.value === this.staked_asset_id.value) {
                //Compound rewards
                staker.stake = new UintN64(staker.stake.native + rewardRate);
                this.total_staked.value = new UintN64(this.total_staked.value.native + rewardRate);
              } else {
                staker.accruedASARewards = new UintN64(staker.accruedASARewards.native + rewardRate);
              }
            } else {
              // For the edge case where the reward rate is > remaining rewards. We accrue the remainder to the user
              if (this.reward_asset_id.value === this.staked_asset_id.value) {
                //Compound rewards
                const diff: uint64 = rewardRate - this.injected_asa_rewards.value.native;
                staker.stake = new UintN64(staker.stake.native + diff);
                this.total_staked.value = new UintN64(
                  this.total_staked.value.native + (rewardRate - this.injected_asa_rewards.value.native)
                );
              } else {
                staker.accruedASARewards = new UintN64(staker.accruedASARewards.native + rewardRate);
              }
              this.injected_asa_rewards.value = new UintN64(0);
            }

            this.stakers.value[i] = staker.copy();
          }
        }
      }
      this.last_accrual_time.value = new UintN64(Global.latestTimestamp);
    }
  }

  private getStaker(address: Address): StakeInfo {
    for (let i: uint64 = 0; i < this.num_stakers.value.native; i += 1) {
      if (Global.opcodeBudget < 300) {
        ensureBudget(Global.opcodeBudget + 700);
      }
      if (this.stakers.value[i].account === address) {
        return this.stakers.value[i].copy();
      }
    }
    return new StakeInfo({
      account: new arc4.Address(Global.zeroAddress),
      stake: new UintN64(0),
      accruedASARewards: new UintN64(0),
    }).copy();
  }
  @abimethod({ allowActions: "NoOp" })
  claimRewards(): void {
    const staker = this.getStaker(new arc4.Address(op.Txn.sender));

    if (staker.accruedASARewards.native > 0) {
      itxn
        .assetTransfer({
          xferAsset: this.reward_asset_id.value.native,
          assetReceiver: op.Txn.sender,
          sender: Global.currentApplicationAddress,
          assetAmount: staker.accruedASARewards.native,
          fee: STANDARD_TXN_FEE,
        })
        .submit();
      staker.accruedASARewards = new UintN64(0);
    }
    if (Global.opcodeBudget < 300) {
      ensureBudget(Global.opcodeBudget + 700);
    }
    this.setStaker(staker.account, staker);
  }
  @abimethod({ allowActions: "NoOp" })
  unstake(quantity: uint64): void {
    for (let i: uint64 = 0; i < this.num_stakers.value.native; i += 1) {
      if (Global.opcodeBudget < 300) {
        ensureBudget(Global.opcodeBudget + 700);
      }
      const staker = this.stakers.value[i].copy();
      if (staker.account === new arc4.Address(op.Txn.sender)) {
        if (staker.stake.native > 0) {
          assert(staker.stake.native >= quantity);
          if (this.staked_asset_id.value.native === 0) {
            itxn
              .payment({
                amount: quantity === 0 ? staker.stake.native : quantity,
                receiver: op.Txn.sender,
                sender: Global.currentApplicationAddress,
                fee: 0,
              })
              .submit();
          } else {
            itxn
              .assetTransfer({
                xferAsset: this.staked_asset_id.value.native,
                assetReceiver: op.Txn.sender,
                sender: Global.currentApplicationAddress,
                assetAmount: quantity === 0 ? staker.stake.native : quantity,
                fee: STANDARD_TXN_FEE,
              })
              .submit();
          }
        }
        //check other rewards
        if (staker.accruedASARewards.native > 0) {
          itxn
            .assetTransfer({
              xferAsset: this.reward_asset_id.value.native,
              assetReceiver: op.Txn.sender,
              sender: Global.currentApplicationAddress,
              assetAmount: staker.accruedASARewards.native,
              fee: STANDARD_TXN_FEE,
            })
            .submit();
          staker.accruedASARewards = new UintN64(0);
        }

        // Update the total staked value
        this.total_staked.value = new UintN64(this.total_staked.value.native - (quantity === 0 ? staker.stake.native : quantity));

        if (Global.opcodeBudget < 300) {
          ensureBudget(Global.opcodeBudget + 700);
        }

        if (quantity === 0) {
          const removedStaker = new StakeInfo({
            account: new arc4.Address(Global.zeroAddress),
            stake: new UintN64(0),
            accruedASARewards: new UintN64(0),
          }).copy();
          this.setStaker(staker.account, removedStaker);
          //copy last staker to the removed staker position
          const lastStaker = this.getStaker(this.stakers.value[this.num_stakers.value.native - 1].account);
          const lastStakerIndex = this.getStakerIndex(this.stakers.value[this.num_stakers.value.native - 1].account);
          if (Global.opcodeBudget < 300) {
            ensureBudget(Global.opcodeBudget + 700);
          }
          this.setStakerAtIndex(lastStaker, i);
          //remove old record of last staker
          this.setStakerAtIndex(removedStaker, lastStakerIndex);
          this.num_stakers.value = new UintN64(this.num_stakers.value.native - 1);
        } else {
          staker.stake = new UintN64(staker.stake.native - quantity);
          staker.accruedASARewards = new UintN64(0);
        }
        this.setStaker(staker.account, staker);
      }
    }
  }

  private getStakerIndex(address: Address): uint64 {
    for (let i: uint64 = 0; i < this.num_stakers.value.native; i += 1) {
      if (this.stakers.value[i].account === address) {
        return i;
      }
    }
    return 0;
  }

  private setStaker(stakerAccount: Address, staker: StakeInfo): void {
    for (let i: uint64 = 0; i < this.num_stakers.value.native; i += 1) {
      if (Global.opcodeBudget < 300) {
        ensureBudget(Global.opcodeBudget + 700);
      }
      if (this.stakers.value[i].account === stakerAccount) {
        this.stakers.value[i] = staker.copy();
        return;
      } else if (this.stakers.value[i].account === new arc4.Address(Global.zeroAddress)) {
        this.stakers.value[i] = staker.copy();
        return;
      }
    }
  }
  private setStakerAtIndex(staker: StakeInfo, index: uint64): void {
    this.stakers.value[index] = staker.copy();
  }

  gas(): void {}
}
export abstract class FluxGateStub extends Contract {
  @abimethod({ allowActions: "NoOp" })
  getUserTier(user: arc4.Address): UintN64 {
    err("stub only");
  }
}
