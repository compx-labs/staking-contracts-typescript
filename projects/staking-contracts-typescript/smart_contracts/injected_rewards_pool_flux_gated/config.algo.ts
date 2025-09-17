import { arc4, uint64 } from "@algorandfoundation/algorand-typescript";
import { divw, mulw } from "@algorandfoundation/algorand-typescript/op";

export const PRECISION: uint64 = 1_000_000_000_000_000;

// storage cost total bytes: 32+8+8 = 48

export type mbrReturn = {
  mbrPayment: uint64;
};

export const MAX_STAKERS_PER_POOL: uint64 = 500;
export const ASSET_HOLDING_FEE: uint64 = 100000; // creation/holding fee for asset
export const ALGORAND_ACCOUNT_MIN_BALANCE: uint64 = 100000;
export const VERSION: uint64 = 3010;
export const INITIAL_PAY_AMOUNT: uint64 = 10_000_000;
export const STANDARD_TXN_FEE: uint64 = 1_000;

export class StakeInfo extends arc4.Struct<{
  account: arc4.Address;
  stake: arc4.UintN64;
  accruedASARewards: arc4.UintN64;
}> {}


export function mulDivW(a: uint64, b: uint64, c: uint64): uint64 {
  const [hi, lo] = mulw(a, b);
  return divw(hi, lo, c);
}
