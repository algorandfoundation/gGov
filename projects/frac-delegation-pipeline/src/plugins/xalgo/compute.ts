/**
 * Round-weighted attribution of xALGO to its beneficial holders, and the conversion to algoquarters.
 *
 * Custody-based and conserved: at every instant each circulating xALGO unit is credited to exactly
 * one beneficiary — the address holding it, or, for the xALGO inside the Folks lending pool, the
 * fxALGO holders pro rata, with Folks escrows resolved to their owners. See README.md.
 */

import { MICROALGO_ROUNDS_PER_AQ, type AssetTransfer } from 'ggov-algoquarters'
import { beneficiaryOf } from './beneficiaries.ts'
import { INDEX_SCALE, RATE_SCALER, XALGO_POOL_ADDRESS } from './constants.ts'
import { isExcluded } from './exclusions.ts'
import { applyTransfer } from './ledger.ts'
import type { BalanceMap, BeneficiaryMap, TaggedTransfer } from './types.ts'

/** What a window's replay attributes, before the rate is applied and before flooring. */
export interface Attribution {
  /** beneficiary address → µxALGO·rounds × INDEX_SCALE (direct xALGO plus pool share, escrows folded into owners) */
  byBeneficiary: Map<string, bigint>
  /**
   * Pool xALGO·rounds × INDEX_SCALE accrued while no fxALGO was in circulation — nobody's to claim.
   * Zero in any window the pool has depositors, i.e. every real window.
   */
  unattributed: bigint
}

/**
 * Exact attribution over rounds `[startRound, endRound)`, per beneficiary. The supplied balances are
 * modified during transfer replay.
 *
 * Two accruals run side by side over the merged, chronologically ordered transfer stream:
 *
 * 1. **Direct xALGO**, exactly `talgo/compute.ts`: an address earns `xalgo × rounds` for every
 *    interval its balance is constant; settled lazily when the balance changes and at `endRound`.
 *    Excluded addresses (reserve, pool) earn nothing here.
 *
 * 2. **Pool share via a cumulative index** (reward-per-share): the pool's xALGO is split among
 *    fxALGO holders by balance, and that split drifts with every deposit, withdrawal, borrow and
 *    repayment. Rather than re-settling every holder at every pool event, keep
 *    `R = ∫ ratio dt`, `ratio = poolXalgo / fxCirculating` (fxCirculating = total fxALGO − the pool's
 *    own reserve balance; ratio = 0 while fxCirculating = 0). Each fxALGO holder (the pool itself
 *    excepted) earns `fxalgo × ΔR` for every interval its fxALGO balance is constant.
 *
 * Why it is conserved: R only advances between distinct rounds and every holder is settled before
 * its own balance changes, so Σ_h fxalgo_h × ΔR telescopes to fxC × ΔR = poolX × Δrounds × INDEX_SCALE
 * per step, up to the single floor; direct accrual covers everything outside the pool and the
 * reserve. Rounding: each step floors R down by < 1 scaled unit, so a holder is short by less than
 * `fxalgo × steps / INDEX_SCALE` µxALGO·rounds — realistically ~1e-11 AQ, always downward. Inner
 * transactions share their outer transaction's `intraOffset`, so a deposit's xALGO-in and fxALGO-out
 * are one instant: zero rounds elapse between them and their relative order does not matter.
 *
 * @param beneficiaries resolved fxALGO holders; an escrow's accrual (direct and pool share alike) is
 *   credited to its owner before flooring, anything unresolved is credited to itself
 */
export function computeAttribution(
  balances: BalanceMap,
  transfers: TaggedTransfer[],
  startRound: number,
  endRound: number,
  beneficiaries: BeneficiaryMap,
): Attribution {
  if (endRound < startRound) throw new Error('Non-monotonic round')

  // Per holding address: µxALGO·rounds × INDEX_SCALE, direct and pool share combined
  const scaled = new Map<string, bigint>()
  const lastRoundDirect = new Map<string, number>()
  const lastR = new Map<string, bigint>()

  // The pool index. Total fxALGO is invariant under transfers, so the circulating amount is one
  // subtraction away at any time.
  let R = 0n
  let indexRound = startRound
  let unattributed = 0n
  let fxTotal = 0n
  for (const balance of balances.values()) fxTotal += balance.fxalgo
  const poolXalgo = () => balances.get(XALGO_POOL_ADDRESS)?.xalgo ?? 0n
  const fxCirculating = () => fxTotal - (balances.get(XALGO_POOL_ADDRESS)?.fxalgo ?? 0n)

  function credit(address: string, amount: bigint): void {
    scaled.set(address, (scaled.get(address) ?? 0n) + amount)
  }

  /** Bring R up to `round` at the ratio in force since `indexRound`. Must run before any event of a new round is applied. */
  function advanceIndex(round: number): void {
    if (round < indexRound) throw new Error('Non-monotonic round')
    if (round === indexRound) return
    const poolX = poolXalgo()
    if (poolX > 0n) {
      const elapsed = BigInt(round - indexRound)
      const fxC = fxCirculating()
      // One floor per step: the whole rounding story of this module
      if (fxC > 0n) R += (poolX * elapsed * INDEX_SCALE) / fxC
      else unattributed += poolX * elapsed * INDEX_SCALE
    }
    indexRound = round
  }

  /** Lazy direct accrual for one address up to `round`, at the xALGO balance it held since its last settlement. */
  function accrueDirect(address: string, round: number): void {
    if (isExcluded(address)) return
    const previousRound = lastRoundDirect.get(address)
    // First time this address appears in the window; start tracking it here
    if (previousRound === undefined) {
      lastRoundDirect.set(address, round)
      return
    }
    const elapsedRounds = round - previousRound
    if (elapsedRounds === 0) return
    if (elapsedRounds < 0) throw new Error('Non-monotonic round')
    const xalgo = balances.get(address)?.xalgo ?? 0n
    if (xalgo > 0n) credit(address, xalgo * BigInt(elapsedRounds) * INDEX_SCALE)
    lastRoundDirect.set(address, round)
  }

  /** Lazy pool-share settlement for one fxALGO holder, at the fxALGO balance it held since its last settlement. */
  function settleFx(address: string): void {
    // the pool's own fxALGO is the un-minted reserve, never a claim on itself
    if (address === XALGO_POOL_ADDRESS) return
    const previousR = lastR.get(address)
    if (previousR === undefined) {
      lastR.set(address, R)
      return
    }
    const deltaR = R - previousR
    if (deltaR === 0n) return
    const fxalgo = balances.get(address)?.fxalgo ?? 0n
    if (fxalgo > 0n) credit(address, fxalgo * deltaR)
    lastR.set(address, R)
  }

  // Opening positions start their cursors at the window start
  for (const [address, balance] of balances) {
    if (balance.xalgo > 0n && !isExcluded(address)) lastRoundDirect.set(address, startRound)
    if (balance.fxalgo > 0n && address !== XALGO_POOL_ADDRESS) lastR.set(address, 0n)
  }

  for (const t of transfers) {
    advanceIndex(t.round)
    const settle = t.asset === 'xalgo' ? (address: string) => accrueDirect(address, t.round) : settleFx
    settle(t.sender)
    settle(t.receiver)
    if (t.closeTo) settle(t.closeTo)
    applyTransfer(balances, t, t.asset)
  }

  // Settle everything up to the end of the window
  advanceIndex(endRound)
  for (const address of lastRoundDirect.keys()) accrueDirect(address, endRound)
  for (const address of lastR.keys()) settleFx(address)

  // Fold escrows into their owners, exact and before any flooring
  const byBeneficiary = new Map<string, bigint>()
  for (const [address, amount] of scaled) {
    if (amount === 0n) continue
    const beneficiary = beneficiaryOf(beneficiaries, address)
    byBeneficiary.set(beneficiary, (byBeneficiary.get(beneficiary) ?? 0n) + amount)
  }
  return { byBeneficiary, unattributed }
}

/**
 * Convert exact attribution to integer AQ at the window's fixed xALGO/ALGO rate, flooring once per
 * beneficiary: `floor(attributed × rate / (INDEX_SCALE × RATE_SCALER × MICROALGO_ROUNDS_PER_AQ))`.
 * Keeping the rate out of the accrual keeps the conservation tests rate-free.
 */
export function toAlgoQuarters(byBeneficiary: Map<string, bigint>, xAlgoRate: bigint): Map<string, bigint> {
  const divisor = INDEX_SCALE * RATE_SCALER * MICROALGO_ROUNDS_PER_AQ
  return new Map([...byBeneficiary].map(([address, attributed]) => [address, (attributed * xAlgoRate) / divisor]))
}

/**
 * Merge and chronologically sort xALGO and fxALGO transfers by `(round, intraOffset)`, tagging each
 * with its asset. Same-instant events keep a stable order (xALGO first); the replay does not depend
 * on it.
 */
export function mergeAssetTransfers(
  xAlgoTransfers: AssetTransfer[],
  fxAlgoTransfers: AssetTransfer[],
): TaggedTransfer[] {
  const transfers: TaggedTransfer[] = [
    ...xAlgoTransfers.map((transfer) => ({ ...transfer, asset: 'xalgo' as const })),
    ...fxAlgoTransfers.map((transfer) => ({ ...transfer, asset: 'fxalgo' as const })),
  ]
  transfers.sort((a, b) => a.round - b.round || a.intraOffset - b.intraOffset)
  return transfers
}
