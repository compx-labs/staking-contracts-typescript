import { arc4 } from "@algorandfoundation/algorand-typescript";

export class StakeInfo extends arc4.Struct<{
  account: arc4.Address;
  stake: arc4.UintN64;
  accruedASARewards: arc4.UintN64;
}> {}
