/** Snapshot supply, holder statistics, and eligibility checks. */

import { STALGO_APP_ADDRESS, TALGO_APP_ADDRESS } from '../constants/tinyman'
import { totalSupply } from '../ledger'
import { deserializeBalances } from './operations'
import type { BalanceMap, SnapshotData } from '../types'

const TOP_N = 5
const LARGE_HOLDER_THRESHOLD_PERCENT = 15n

function analyzeSnapshot(data: SnapshotData) {
  const eligible = deserializeBalances(data.balances)
  const excluded = deserializeBalances(data.excluded)
  const all = new Map([...eligible, ...excluded])
  const supply = totalSupply(all)

  const tAlgoReserve = all.get(TALGO_APP_ADDRESS)?.talgo ?? 0n
  const stAlgoReserve = all.get(STALGO_APP_ADDRESS)?.stalgo ?? 0n
  const tAlgoInStAlgoEscrow = all.get(STALGO_APP_ADDRESS)?.talgo ?? 0n

  return {
    eligible,
    excluded,
    tAlgoReserve,
    tAlgoInStAlgoEscrow,
    stAlgoReserve,
    circulating: {
      talgo: supply.talgo - tAlgoReserve - tAlgoInStAlgoEscrow,
      stalgo: supply.stalgo - stAlgoReserve,
    },
  }
}

function formatPercent(amount: bigint, total: bigint): string {
  return total > 0n ? (Number((amount * 10_000n) / total) / 100).toFixed(2) : '0.00'
}

function topHolders(balances: BalanceMap, asset: 'talgo' | 'stalgo') {
  return [...balances.entries()]
    .filter(([, balance]) => balance[asset] > 0n)
    .sort(([addressA, a], [addressB, b]) =>
      a[asset] === b[asset] ? addressA.localeCompare(addressB) : a[asset] > b[asset] ? -1 : 1,
    )
    .slice(0, TOP_N)
}

/** Log supply and holder statistics for a snapshot. */
export function logSnapshotStats(data: SnapshotData): void {
  const { eligible, excluded, circulating, tAlgoReserve, tAlgoInStAlgoEscrow, stAlgoReserve } = analyzeSnapshot(data)
  const el = [...eligible.values()]
  const ex = [...excluded.values()]
  const tAlgoHolders = el.filter((balance) => balance.talgo > 0n).length
  const stAlgoHolders = el.filter((balance) => balance.stalgo > 0n).length
  const uniqueHolders = el.filter((balance) => balance.talgo > 0n || balance.stalgo > 0n).length
  const bothHolders = el.filter((balance) => balance.talgo > 0n && balance.stalgo > 0n).length
  const tAlgoExcluded = ex.filter((balance) => balance.talgo > 0n).length
  const stAlgoExcluded = ex.filter((balance) => balance.stalgo > 0n).length

  console.log(`\nAssets supply at round ${data.round}:`)
  console.log(`\n  [tALGO] circulating            ${circulating.talgo.toLocaleString()}`)
  console.log(`  [tALGO] in reserve             ${tAlgoReserve.toLocaleString()}`)
  console.log(`  [tALGO] in stALGO escrow       ${tAlgoInStAlgoEscrow.toLocaleString()}`)
  console.log(`  [tALGO] non-zero holders       ${tAlgoHolders}  (excluded: ${tAlgoExcluded})`)
  console.log(`\n  [stALGO] circulating           ${circulating.stalgo.toLocaleString()}`)
  console.log(`  [stALGO] in reserve            ${stAlgoReserve.toLocaleString()}`)
  console.log(`  [stALGO] non-zero holders      ${stAlgoHolders}  (excluded: ${stAlgoExcluded})`)
  console.log(`\n  tALGO+stALGO non-zero holders  ${uniqueHolders}  (holding both: ${bothHolders})`)

  console.log(`\nTop ${TOP_N} tALGO holders (check if any should be in exclusions.ts):`)
  for (const [address, balance] of topHolders(eligible, 'talgo')) {
    console.log(`  ${address}  ${balance.talgo.toLocaleString()} (${formatPercent(balance.talgo, circulating.talgo)}%)`)
  }

  console.log(`\nTop ${TOP_N} stALGO holders (check if any should be in exclusions.ts):`)
  for (const [address, balance] of topHolders(eligible, 'stalgo')) {
    console.log(
      `  ${address}  ${balance.stalgo.toLocaleString()} (${formatPercent(balance.stalgo, circulating.stalgo)}%)`,
    )
  }
}

/** Throw if an eligible address exceeds the configured share of circulating supply. */
export function checkLargeHolders(data: SnapshotData): void {
  const { eligible, circulating } = analyzeSnapshot(data)
  const largeHolders = [...eligible.entries()].filter(
    ([, balance]) =>
      balance.talgo * 100n > circulating.talgo * LARGE_HOLDER_THRESHOLD_PERCENT ||
      balance.stalgo * 100n > circulating.stalgo * LARGE_HOLDER_THRESHOLD_PERCENT,
  )

  if (largeHolders.length === 0) return

  const lines = [
    `${largeHolders.length} non-excluded address(es) hold >${LARGE_HOLDER_THRESHOLD_PERCENT}% of circulating supply; check if it should be added to exclusions.ts or tweak LARGE_HOLDER_THRESHOLD_PERCENT to avoid this error:`,
  ]
  for (const [address, balance] of largeHolders) {
    lines.push(
      `  ${address}  tALGO: ${formatPercent(balance.talgo, circulating.talgo)}%  stALGO: ${formatPercent(balance.stalgo, circulating.stalgo)}%`,
    )
  }
  throw new Error(lines.join('\n'))
}
