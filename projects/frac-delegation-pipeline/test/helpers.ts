/** Shared fixtures for the tALGO invariant unit tests. */

import { readFileSync } from 'node:fs'

import { expect } from 'vitest'

import type { AccountWithAlgoQuarters, AlgoQuartersData, AssetTransfer } from 'ggov-algoquarters'
import type { BalanceMap, TaggedTransfer } from '../src/plugins/talgo/types.ts'

// ledger.ts and compute.ts never validate address format, so readable ids keep fixtures legible
export const ALICE = 'ALICE'
export const BOB = 'BOB'
export const CAROL = 'CAROL'
export const ESCROW = 'ESCROW'

export function makeTransfer(overrides: Partial<AssetTransfer> & { sender: string; receiver: string }): AssetTransfer {
  return { round: 1, intraOffset: 0, amount: 0n, ...overrides }
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

export function readJsonLines<T>(path: string): T[] {
  const text = readFileSync(path, 'utf-8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as T) : []
}

export function expectAlgoQuarterTotals(data: AlgoQuartersData): void {
  expect(data.totalAccounts).toBe(data.accounts.length)
  const summed = data.accounts.reduce((sum, account) => sum + BigInt(account.algoQuarters), 0n)
  expect(summed.toString()).toBe(data.totalAlgoQuarters)
}

export function expectSortedPositiveUint32AlgoQuarters(
  accounts: AccountWithAlgoQuarters[],
  options: { isExcluded?: (account: string) => boolean } = {},
): void {
  for (let i = 0; i < accounts.length; i++) {
    const { account, algoQuarters } = accounts[i]
    if (i > 0) expect(accounts[i - 1].account < account).toBe(true)
    expect(algoQuarters).toMatch(/^\d+$/)
    expect(BigInt(algoQuarters)).toBeGreaterThan(0n)
    expect(BigInt(algoQuarters)).toBeLessThanOrEqual(4_294_967_295n)
    if (options.isExcluded) expect(options.isExcluded(account)).toBe(false)
  }
}
