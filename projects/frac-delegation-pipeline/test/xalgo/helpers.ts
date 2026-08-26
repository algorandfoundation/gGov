/** Shared fixtures for the xALGO invariant unit tests. */

import type { AssetTransfer } from '../../src/aq/index.ts'
import { XALGO_APP_ADDRESS, XALGO_POOL_ADDRESS } from '../../src/plugins/xalgo/constants.ts'
import type { BalanceMap, BeneficiaryMap, TaggedTransfer, XalgoAsset } from '../../src/plugins/xalgo/types.ts'
import { makeTransfer } from '../helpers.ts'

export { ALICE, BOB, CAROL, makeTransfer } from '../helpers.ts'

// The two excluded addresses: compute.ts keys on the real ones, so fixtures must too
export const POOL = XALGO_POOL_ADDRESS
export const RESERVE = XALGO_APP_ADDRESS
// Folks escrows and their owner — readable ids, like ALICE and friends
export const OWNER = 'OWNER'
export const ESCROW1 = 'ESCROW1'
export const ESCROW2 = 'ESCROW2'

// 1 ALGO held for QUARTER rounds = 1 AQ
export const QUARTER = 3_000_000

export function makeXalgoTagged(
  asset: XalgoAsset,
  overrides: Partial<AssetTransfer> & { sender: string; receiver: string },
): TaggedTransfer {
  return { ...makeTransfer(overrides), asset }
}

export function xalgoBalancesOf(...entries: [address: string, xalgo: bigint, fxalgo: bigint][]): BalanceMap {
  return new Map(entries.map(([address, xalgo, fxalgo]) => [address, { xalgo, fxalgo }]))
}

export function cloneBalances(balances: BalanceMap): BalanceMap {
  return new Map([...balances].map(([address, b]) => [address, { xalgo: b.xalgo, fxalgo: b.fxalgo }]))
}

/** A beneficiary map where every listed escrow belongs to `owner`. */
export function escrowsOf(owner: string, ...escrows: string[]): BeneficiaryMap {
  return new Map(escrows.map((escrow) => [escrow, { kind: 'escrow', owner, app: 971389489, optInRound: 1 }]))
}

export const NO_ESCROWS: BeneficiaryMap = new Map()

export function sumValues(map: Map<string, bigint>): bigint {
  let sum = 0n
  for (const value of map.values()) sum += value
  return sum
}

/**
 * A deposit of `xalgo` into the pool against `fxalgo` minted to `holder`, as the chain emits it:
 * two transfers in one instant (inner transactions share the outer intraOffset).
 */
export function deposit(
  holder: string,
  xalgo: bigint,
  fxalgo: bigint,
  round: number,
  intraOffset = 0,
  receiver: string = holder,
): TaggedTransfer[] {
  return [
    makeXalgoTagged('xalgo', { sender: holder, receiver: POOL, amount: xalgo, round, intraOffset }),
    makeXalgoTagged('fxalgo', { sender: POOL, receiver, amount: fxalgo, round, intraOffset }),
  ]
}

/** The reverse: `fxalgo` burned back to the pool reserve, `xalgo` paid out of the pool. */
export function withdraw(
  holder: string,
  fxalgo: bigint,
  xalgo: bigint,
  round: number,
  intraOffset = 0,
): TaggedTransfer[] {
  return [
    makeXalgoTagged('fxalgo', { sender: holder, receiver: POOL, amount: fxalgo, round, intraOffset }),
    makeXalgoTagged('xalgo', { sender: POOL, receiver: holder, amount: xalgo, round, intraOffset }),
  ]
}
