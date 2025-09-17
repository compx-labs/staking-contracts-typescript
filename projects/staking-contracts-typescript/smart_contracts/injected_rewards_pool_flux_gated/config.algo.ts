import { arc4, uint64 } from "@algorandfoundation/algorand-typescript";
import { divw, mulw } from "@algorandfoundation/algorand-typescript/op";

export const PRECISION: uint64 = 1_000_000_000_000_000;

// storage cost total bytes: 32+8+8 = 48

export type mbrReturn = {
  mbrPayment: uint64;
};

export const MAX_STAKERS_PER_POOL: uint64 = 500;
export const ALGORAND_ACCOUNT_MIN_BALANCE: uint64 = 100000;
export const VERSION: uint64 = 4000;
export const INITIAL_PAY_AMOUNT: uint64 = 400_000;
export const STANDARD_TXN_FEE: uint64 = 1_000;
export const BOX_FEE: uint64 = 22_500;

export class StakeInfoRecord extends arc4.Struct<{
  stake: arc4.UintN64;
  lastRewardIndex: arc4.UintN64;
  // the number of asa rewards in the contract at the time of unstake or reward claiming by this user.
  // Used to calculate their rewards versus the current total of rewards.
}> {}

export function mulDivW(a: uint64, b: uint64, c: uint64): uint64 {
  const [hi, lo] = mulw(a, b);
  return divw(hi, lo, c);
}
