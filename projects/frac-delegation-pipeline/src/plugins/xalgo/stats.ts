/** Snapshot supply, holder statistics, and eligibility checks. */

import { FOLKS_ESCROW_APP_BY_ID, XALGO_APP_ADDRESS, XALGO_POOL_ADDRESS } from './constants.ts'
import { totalSupply } from './ledger.ts'
import { deserializeBalances } from './snapshot.ts'
import type { BalanceMap, BeneficiaryMap, SnapshotData, XalgoAsset } from './types.ts'

const TOP_N = 5
const LARGE_HOLDER_THRESHOLD_PERCENT = 40n

function analyzeSnapshot(data: SnapshotData) {
  const eligible = deserializeBalances(data.balances)
  const excluded = deserializeBalances(data.excluded)
  const all = new Map([...eligible, ...excluded])
  const supply = totalSupply(all)

  const xAlgoReserve = all.get(XALGO_APP_ADDRESS)?.xalgo ?? 0n
  const xAlgoInPool = all.get(XALGO_POOL_ADDRESS)?.xalgo ?? 0n
  const fxAlgoReserve = all.get(XALGO_POOL_ADDRESS)?.fxalgo ?? 0n
  const circulating = { xalgo: supply.xalgo - xAlgoReserve, fxalgo: supply.fxalgo - fxAlgoReserve }

  return {
    eligible,
    excluded,
    xAlgoReserve,
    xAlgoInPool,
    fxAlgoReserve,
    circulating,
    /** The pool's xALGO per circulating fxALGO, 4 dp: ≈1 when nothing is borrowed out. */
    poolRatio: circulating.fxalgo > 0n ? (xAlgoInPool * 10_000n) / circulating.fxalgo : undefined,
  }
}

function formatPercent(amount: bigint, total: bigint): string {
  return total > 0n ? (Number((amount * 10_000n) / total) / 100).toFixed(2) : '0.00'
}

function topHolders(balances: BalanceMap, asset: XalgoAsset) {
  return [...balances.entries()]
    .filter(([, balance]) => balance[asset] > 0n)
    .sort(([addressA, a], [addressB, b]) =>
      a[asset] === b[asset] ? addressA.localeCompare(addressB) : a[asset] > b[asset] ? -1 : 1,
    )
    .slice(0, TOP_N)
}

/** `(escrow of OWNER, loan GENERAL)` when the holder is a resolved escrow, else nothing. */
function describeHolder(address: string, beneficiaries?: BeneficiaryMap): string {
  const entry = beneficiaries?.get(address)
  if (entry?.kind !== 'escrow') return ''
  const app = FOLKS_ESCROW_APP_BY_ID.get(BigInt(entry.app))
  return `  (escrow of ${entry.owner}, ${app?.label ?? `app ${entry.app}`})`
}

/** Log supply and holder statistics for a snapshot. */
export function logSnapshotStats(data: SnapshotData, beneficiaries?: BeneficiaryMap): void {
  const { eligible, excluded, circulating, xAlgoReserve, xAlgoInPool, fxAlgoReserve, poolRatio } = analyzeSnapshot(data)
  const el = [...eligible.values()]
  const ex = [...excluded.values()]
  const xAlgoHolders = el.filter((balance) => balance.xalgo > 0n).length
  const fxAlgoHolders = el.filter((balance) => balance.fxalgo > 0n).length
  const xAlgoExcluded = ex.filter((balance) => balance.xalgo > 0n).length
  const fxAlgoExcluded = ex.filter((balance) => balance.fxalgo > 0n).length

  console.log(`\nAssets supply at round ${data.round}:`)
  console.log(`\n  [xALGO] circulating            ${circulating.xalgo.toLocaleString()}`)
  console.log(`  [xALGO] in reserve             ${xAlgoReserve.toLocaleString()}`)
  console.log(
    `  [xALGO] in Folks pool          ${xAlgoInPool.toLocaleString()} (${formatPercent(xAlgoInPool, circulating.xalgo)}% of circulating)`,
  )
  console.log(`  [xALGO] non-zero holders       ${xAlgoHolders}  (excluded: ${xAlgoExcluded})`)
  console.log(`\n  [fxALGO] circulating           ${circulating.fxalgo.toLocaleString()}`)
  console.log(`  [fxALGO] in pool reserve       ${fxAlgoReserve.toLocaleString()}`)
  console.log(`  [fxALGO] non-zero holders      ${fxAlgoHolders}  (excluded: ${fxAlgoExcluded})`)
  console.log(
    `  pool xALGO per circulating fxALGO: ${poolRatio === undefined ? 'n/a' : (Number(poolRatio) / 10_000).toFixed(4)}  (≈1; lower = xALGO borrowed out)`,
  )

  console.log(`\nTop ${TOP_N} xALGO holders (% of circulating supply):`)
  for (const [address, balance] of topHolders(eligible, 'xalgo')) {
    console.log(
      `  ${address}  ${balance.xalgo.toLocaleString()} (${formatPercent(balance.xalgo, circulating.xalgo)}%)${describeHolder(address, beneficiaries)}`,
    )
  }

  console.log(`\nTop ${TOP_N} fxALGO holders (% of circulating supply):`)
  for (const [address, balance] of topHolders(eligible, 'fxalgo')) {
    console.log(
      `  ${address}  ${balance.fxalgo.toLocaleString()} (${formatPercent(balance.fxalgo, circulating.fxalgo)}%)${describeHolder(address, beneficiaries)}`,
    )
  }
}

/**
 * Throw if an eligible address exceeds the configured share of circulating supply of either asset.
 * The pool is excluded, so its ~60% of xALGO never trips this.
 */
export function checkLargeHolders(data: SnapshotData): void {
  const { eligible, circulating } = analyzeSnapshot(data)
  const largeHolders = [...eligible.entries()].filter(
    ([, balance]) =>
      balance.xalgo * 100n > circulating.xalgo * LARGE_HOLDER_THRESHOLD_PERCENT ||
      balance.fxalgo * 100n > circulating.fxalgo * LARGE_HOLDER_THRESHOLD_PERCENT,
  )

  if (largeHolders.length === 0) return

  const lines = [
    `${largeHolders.length} non-excluded address(es) hold >${LARGE_HOLDER_THRESHOLD_PERCENT}% of circulating supply. If it's an escrow/reserve contract, add it to exclusions.ts; if it's an LP pool or other real holder, disregard or tweak LARGE_HOLDER_THRESHOLD_PERCENT instead:`,
  ]
  for (const [address, balance] of largeHolders) {
    lines.push(
      `  ${address}  xALGO: ${formatPercent(balance.xalgo, circulating.xalgo)}%  fxALGO: ${formatPercent(balance.fxalgo, circulating.fxalgo)}%`,
    )
  }
  throw new Error(lines.join('\n'))
}
