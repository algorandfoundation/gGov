/** Shared fixtures for the invariant unit tests. */

import type { AssetTransfer, BalanceMap, TaggedTransfer } from '../src/types'

// ledger.ts and compute.ts never validate address format, so readable ids keep fixtures legible
export const ALICE = 'ALICE'
export const BOB = 'BOB'
export const CAROL = 'CAROL'
export const ESCROW = 'ESCROW'

export function makeTransfer(overrides: Partial<AssetTransfer> & { sender: string; receiver: string }): AssetTransfer {
  return { round: 1, timestamp: 0, intraOffset: 0, amount: 0n, ...overrides }
}

export function makeTagged(
  asset: 'talgo' | 'stalgo',
  overrides: Partial<AssetTransfer> & { sender: string; receiver: string },
): TaggedTransfer {
  return { ...makeTransfer(overrides), asset }
}

export function balancesOf(...entries: [address: string, talgo: bigint, stalgo: bigint][]): BalanceMap {
  return new Map(entries.map(([address, talgo, stalgo]) => [address, { talgo, stalgo }]))
}
