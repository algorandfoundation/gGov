import {
  DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS,
  GGOV_VOTE_RECORD_KEY_LENGTH,
  voteRecordBoxMbr,
  type GGovPeriod,
} from 'ggov-sdk'

/**
 * How much MBR each registry must be able to *supply*, worst case.
 *
 * Both registries fund their children rather than themselves. A vote writes its record on the
 * period app (gGov) or the instance app (frac), with no payment attached; when that child hits its
 * min-balance floor, `checkNeedMBR` pulls a fixed `mbrTopUp` chunk off the registry
 * (`ggovPeriod.algo.ts` / `fracDelegationInstance.algo.ts`). Delegating is the one obligation the
 * gGov registry pays directly: `delegations` + `reverseDelegations` boxes, again unpaid by the
 * caller (`ggov-sdk/src/constants.ts`). It pays them for frac-registry accounts too, which is why
 * the gGov estimate carries a pooled delegation term the frac one does not.
 *
 * Everything here is pure arithmetic over already-fetched data — see `hooks/mbrQueries.ts` for the
 * reads. Deliberately excluded, because none of it is a voter voting or an eligible account
 * delegating: AQ ingestion (frac registry, 19_700/new account), child-app creation MBR, and
 * committee ingestion (~23_700/member). All are admin-triggered and separately budgeted.
 */

/** An account's µAlgo above its min-balance floor — what it can actually pay out. */
export function spendable(amount: bigint, minBalance: bigint): bigint {
  return amount > minBalance ? amount - minBalance : 0n
}

/**
 * What a registry actually parts with to cover a child's shortfall.
 *
 * `requestMBR` sends a fixed `mbrTopUp` every time the child runs dry, so the drain is the shortfall
 * rounded *up* to whole chunks — never the shortfall itself. A registry sized against the raw
 * shortfall would come up short by up to one chunk per child.
 */
export function drainForChild(need: bigint, childSpendable: bigint, mbrTopUp: bigint): bigint {
  const shortfall = need > childSpendable ? need - childSpendable : 0n
  if (shortfall === 0n || mbrTopUp <= 0n) return shortfall
  return ((shortfall + mbrTopUp - 1n) / mbrTopUp) * mbrTopUp
}

/** Options per topic for a period — what sizes its vote-record box. */
export function optionCountsOf(period: GGovPeriod): number[] {
  return period.topics.map(([options]) => options.length)
}

/** Scale a headcount by a 0–100 turnout assumption, rounding up so a live voter is never dropped. */
export function votersAtTurnout(members: number, turnoutPct: number): number {
  return Math.ceil((members * Math.max(0, Math.min(100, turnoutPct))) / 100)
}

/** One period's contribution to the gGov registry's requirement. */
export interface PeriodMbrRow {
  periodId: number
  /** Committee members assumed to vote, after the turnout assumption. */
  voters: number
  /** Committee members eligible to vote — the ceiling `voters` is scaled from. */
  eligible: number
  /** MBR of a single vote record at this period's ballot shape. */
  perVoter: bigint
  /** `voters * perVoter` — the box MBR this period must end up holding. */
  need: bigint
  /** What the period app can already pay out of its own balance. */
  have: bigint
  /** What the registry supplies, in whole `mbrTopUp` chunks. */
  drain: bigint
  /** False while the period's app account balance is still loading. */
  resolved: boolean
}

/** One instance's contribution to the frac registry's requirement, summed over periods. */
export interface InstanceMbrRow {
  instanceNumId: number
  name: string
  /** Pool members assumed to vote across all counted periods (may double-count across periods). */
  voters: number
  need: bigint
  have: bigint
  drain: bigint
  resolved: boolean
}

export interface GgovMbrEstimate {
  periods: PeriodMbrRow[]
  /** Registered gGov accounts with no delegation yet — each one a future unpaid box pair. */
  undelegatedAccounts: number
  /** `undelegatedAccounts * DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS`. Never scaled by turnout. */
  delegationNeed: bigint
  /** Frac-registry-only accounts with no delegation yet — see {@link splitUndelegated}. */
  undelegatedPooledAccounts: number
  /** `undelegatedPooledAccounts * DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS`. Same rate, same boxes. */
  pooledDelegationNeed: bigint
  /** Σ period drains + `delegationNeed` + `pooledDelegationNeed`. */
  required: bigint
  /** Every period app balance resolved, so `required` is final rather than provisional. */
  resolved: boolean
}

export interface FracMbrEstimate {
  instances: InstanceMbrRow[]
  required: bigint
  resolved: boolean
}

/**
 * Whether a period still counts toward what a registry must supply.
 *
 * Two conditions, and the `ready` half is why this is not simply "the voting window is open":
 *
 * - **Ready.** An unready period is a draft. Its ballot, committee and window are all still
 *   editable, so pricing it would size the registry against numbers nobody has committed to — and
 *   a draft that is never made ready costs nothing at all.
 * - **Not ended.** Once the window closes no further vote record can be written, so whatever the
 *   period still needed is no longer an obligation. The comparison is strict to match the
 *   contracts, which admit a vote on `Global.latestTimestamp < votingEnd`
 *   (`ggovPeriod.algo.ts` / `fracDelegationInstance.algo.ts`) — at `votingEnd` itself the period
 *   has already stopped accepting votes and can no longer draw on the registry.
 *
 * A ready period whose window has not opened yet is the case this exists for: it is frozen and
 * will be voted on, and the registry has to be able to cover it *before* voting starts, not once
 * the first voter is already being turned away.
 */
export function countsTowardMbr(period: { ready: boolean; votingEnd: number }, nowSeconds: number): boolean {
  return period.ready && nowSeconds < period.votingEnd
}

/** A period the registry may still have to fund — see {@link countsTowardMbr}. */
export interface CountedPeriod {
  periodId: number
  optionCounts: number[]
  /** Committee members — the eligible-voter ceiling (`CommitteeMetadata.totalMembers`). */
  members: number
  /** The period app's own spendable balance, or undefined while it loads. */
  childSpendable?: bigint
}

/** Accounts that can still open a delegation, split by which registry vouches for them. */
export interface UndelegatedSplit {
  /** Known to the gGov registry's `accounts` box, and not delegating yet. */
  ggov: number
  /** Known *only* to the frac registry, and not delegating yet. */
  pooled: number
}

/**
 * Who can still open a delegation, and on whose credentials.
 *
 * `setVotingAccount` admits a delegator that either registry knows: `ensureDelegatorRegistered`
 * (`ggovRegistry.algo.ts`) checks the gGov `accounts` box first and falls back to the frac
 * registry's, because an AQ holder may have no gGov committee membership at all. Either way the
 * gGov registry pays the same `delegations` + `reverseDelegations` pair, so both populations are
 * its obligation — but only the frac-*only* half is load the gGov account list does not already
 * show, which is why `pooled` subtracts the overlap rather than counting the frac roster whole.
 *
 * Address sets rather than counters on purpose. `lastAccountId` is a high-water mark, and the
 * delegation roster mixes both populations, so `lastAccountId - delegations.size` would charge a
 * frac-only delegator against the gGov count and under-report the real obligation.
 */
export function splitUndelegated(
  ggovAccounts: Iterable<string>,
  fracAccounts: Iterable<string>,
  delegators: Iterable<string>,
): UndelegatedSplit {
  const ggovSet = new Set(ggovAccounts)
  const delegated = new Set(delegators)

  let ggov = 0
  for (const account of ggovSet) if (!delegated.has(account)) ggov++

  let pooled = 0
  for (const account of new Set(fracAccounts)) {
    if (!ggovSet.has(account) && !delegated.has(account)) pooled++
  }

  return { ggov, pooled }
}

/**
 * gGov registry requirement.
 *
 * The delegation term uses the *new-delegatee* rate (57_800), not the cheaper existing-delegatee one
 * (41_300): the worst case is every remaining account delegating to someone who has no delegators
 * yet, so each pays for a fresh `reverseDelegations` box rather than growing one.
 *
 * Escrows are registered gGov accounts and committee members, so a pooled vote's external re-cast
 * into the period app is already inside `members` — the frac estimate below is additional load on
 * the *frac* registry, not a second count of the same gGov box.
 *
 * Delegation is charged twice over, at the same rate, against two disjoint populations: gGov
 * accounts and frac-registry-only accounts ({@link splitUndelegated}). Both write their boxes on
 * *this* registry — pooled delegation is a gGov obligation, not a frac one — so the split is
 * presentational, letting the panel show where the load comes from without changing the total.
 */
export function estimateGgovRegistry({
  periods,
  undelegated,
  mbrTopUp,
  turnoutPct,
}: {
  periods: CountedPeriod[]
  undelegated: UndelegatedSplit
  mbrTopUp: bigint
  turnoutPct: number
}): GgovMbrEstimate {
  const rows = periods.map<PeriodMbrRow>((p) => {
    const voters = votersAtTurnout(p.members, turnoutPct)
    const perVoter = voteRecordBoxMbr(GGOV_VOTE_RECORD_KEY_LENGTH, p.optionCounts)
    const need = perVoter * BigInt(voters)
    const have = p.childSpendable ?? 0n
    return {
      periodId: p.periodId,
      voters,
      eligible: p.members,
      perVoter,
      need,
      have,
      drain: drainForChild(need, have, mbrTopUp),
      resolved: p.childSpendable !== undefined,
    }
  })

  const delegationNeed = DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS * BigInt(undelegated.ggov)
  const pooledDelegationNeed = DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS * BigInt(undelegated.pooled)

  return {
    periods: rows,
    undelegatedAccounts: undelegated.ggov,
    delegationNeed,
    undelegatedPooledAccounts: undelegated.pooled,
    pooledDelegationNeed,
    required: rows.reduce((sum, r) => sum + r.drain, delegationNeed + pooledDelegationNeed),
    resolved: rows.every((r) => r.resolved),
  }
}

/** One pool's standing in one counted period — what the frac estimate needs per (instance, period). */
export interface CountedPool {
  instanceNumId: number
  name: string
  /**
   * Members assumed able to vote in this period's committee. Prefer the committee-scoped staker
   * count; fall back to the pool's registry-wide roster when no AQ ledger is open yet, since a
   * future period whose committee is not ingested would otherwise read as zero voters.
   */
  members: number
  /**
   * MBR of one `votingRecords` box at this period's ballot shape, i.e.
   * `voteRecordBoxMbr(FRAC_VOTING_RECORD_KEY_LENGTH, optionCounts)`.
   *
   * Passed in already computed rather than derived here, so this module never imports
   * `frac-delegation-sdk`: its generated clients carry large inline ARC-56 specs and are
   * deliberately code-split behind `lib/fracReaderSdk.ts`, and a static value import would pull
   * them into the main bundle for every visitor.
   */
  perVoter: bigint
  /** The instance app's own spendable balance, or undefined while it loads. */
  childSpendable?: bigint
}

/**
 * Frac registry requirement — the voting term only.
 *
 * Frac delegation is not a frac-registry action: the gGov registry is the single source of truth for
 * delegations (`ggovRegistry.algo.ts` `ensureDelegatorRegistered`), so it carries that whole cost.
 *
 * Rows arrive per (instance, period) and are folded per instance, because the drain rounds to whole
 * `mbrTopUp` chunks against one instance balance — rounding each period separately would invent a
 * chunk per period rather than per instance.
 */
export function estimateFracRegistry({
  pools,
  mbrTopUp,
  turnoutPct,
}: {
  pools: CountedPool[]
  mbrTopUp: bigint
  turnoutPct: number
}): FracMbrEstimate {
  const byInstance = new Map<number, InstanceMbrRow>()

  for (const pool of pools) {
    const voters = votersAtTurnout(pool.members, turnoutPct)
    const need = pool.perVoter * BigInt(voters)
    const row = byInstance.get(pool.instanceNumId) ?? {
      instanceNumId: pool.instanceNumId,
      name: pool.name,
      voters: 0,
      need: 0n,
      have: pool.childSpendable ?? 0n,
      drain: 0n,
      resolved: pool.childSpendable !== undefined,
    }
    row.voters += voters
    row.need += need
    byInstance.set(pool.instanceNumId, row)
  }

  const instances = [...byInstance.values()].map((row) => ({
    ...row,
    drain: drainForChild(row.need, row.have, mbrTopUp),
  }))

  return {
    instances,
    required: instances.reduce((sum, r) => sum + r.drain, 0n),
    resolved: instances.every((r) => r.resolved),
  }
}

/** What a registry still has to be given, given what it already holds spendable. */
export function shortfallOf(required: bigint, registrySpendable: bigint): bigint {
  return required > registrySpendable ? required - registrySpendable : 0n
}
