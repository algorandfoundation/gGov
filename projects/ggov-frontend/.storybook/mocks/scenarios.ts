/**
 * Reusable mocked query data for Storybook.
 *
 * A {@link MockScenario} is the whole "world" the aliased `@/hooks/queries`
 * mock reads from: periods, per-period detail, committees, delegations, vote
 * records, eligibility and voting power. Stories either pin a scenario via
 * `parameters.scenario` or let the global toolbar toggles drive
 * {@link defaultScenarioFromGlobals}.
 *
 * Period windows are derived from `Date.now()` so the real `periodStatus()`
 * (src/utils/time.ts) classifies them exactly as the requested phase — the same
 * derivation the app uses, so the toolbar `periodPhase` toggle is faithful.
 */
import type { GGovPeriod, GGovVoteRecord, BodyJson, PeriodBodyJson } from 'ggov-sdk'
import type { PeriodWithId, CommitteeOption, ProducerRank } from '../../src/hooks/queries'
// Re-use the app's real base64url codec so committee keys match the ids the
// components compute via `toBase64Url(period.committeeId)`.
import { toBase64Url } from '../../src/hooks/queries'
import { demoAccounts } from './use-wallet-react'

export type Phase = 'upcoming' | 'active' | 'ended'

/** `${periodId}:${account}` — period-scoped, account-scoped composite key. */
export const pakey = (periodId: number, account: string) => `${periodId}:${account}`
/** `${committeeIdBase64Url}:${account}` — committee-scoped, account-scoped key. */
export const cakey = (committeeIdBase64Url: string, account: string) => `${committeeIdBase64Url}:${account}`

export interface MockScenario {
  /** Drives `usePeriods()` (landing + index lists). `ready` gates voter visibility. */
  periods: PeriodWithId[]
  /** Per-period detail, keyed by numeric period id. */
  periodDetail: Record<
    number,
    {
      period: GGovPeriod
      body: PeriodBodyJson | null
      topicBodies: (BodyJson | null)[]
      /** Distinct accounts that cast a vote; `.length` is the voter count. */
      voters: string[]
      /** On-chain app id of the GGovPeriod contract (TechnicalInfoCard link). */
      appId?: bigint | number
    }
  >
  /** Committee metadata keyed by base64url committee id (`useCommittee`). */
  committees: Record<string, CommitteeOption>
  /** delegator → delegatee pairs; exposed to `useAllDelegations()` as a Map. */
  delegations: Array<[delegator: string, delegatee: string]>
  /** Eligibility + power per `${periodId}:${account}` (`useCanVote`/`useCanVoteMany`). */
  canVote: Record<string, { canVote: boolean; votingPower: bigint }>
  /** Vote record per `${periodId}:${account}`; `null` = eligible but didn't vote. */
  voteRecords: Record<string, GGovVoteRecord | null>
  /** Registry voting power per `${committeeB64}:${account}` (`useXGovVotingPowers`). */
  votingPowers: Record<string, number>
  /** Producer rank per `${committeeB64}:${account}` (`useProducerRank`). */
  producerRanks?: Record<string, ProducerRank | null>
  /** Global registry state (`useGlobalState`, PeriodStatsCard). */
  globalState?: { lastPeriodId?: bigint }
  /** Force loading/error UIs without real async. */
  flags?: { periodsLoading?: boolean; periodLoading?: boolean; periodsError?: boolean }
}

const DAY = 86_400
const nowSecs = () => Math.floor(Date.now() / 1000)

/** Voting window placing a period firmly in the requested phase relative to now. */
function windowFor(phase: Phase): { votingStart: number; votingEnd: number } {
  const n = nowSecs()
  if (phase === 'upcoming') return { votingStart: n + 7 * DAY, votingEnd: n + 21 * DAY }
  if (phase === 'active') return { votingStart: n - 7 * DAY, votingEnd: n + 7 * DAY }
  return { votingStart: n - 30 * DAY, votingEnd: n - 7 * DAY }
}

/** Deterministic 32-byte committee id from a seed (stable across renders/stories). */
export function makeCommitteeId(seed: number): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7 + 11) % 251
  return bytes
}

/** One on-chain topic: `[optionLabels, tallies]` (tallies default to all-zero). */
export function makeTopic(options: string[], tallies?: number[]): [string[], number[]] {
  return [options, tallies ?? options.map(() => 0)]
}

export function makePeriodBody(title: string, body: string, electSeats?: number): PeriodBodyJson {
  return electSeats !== undefined ? { title, body, electSeats } : { title, body }
}

export function makeCommittee(
  committeeId: Uint8Array,
  opts?: { totalMembers?: number; totalVotes?: number; periodStart?: number; periodEnd?: number },
): CommitteeOption {
  return {
    id: committeeId,
    idBase64Url: toBase64Url(committeeId),
    periodStart: opts?.periodStart ?? 59_000_000,
    periodEnd: opts?.periodEnd ?? 62_000_000,
    totalMembers: opts?.totalMembers ?? 1_240,
    totalVotes: opts?.totalVotes ?? 84_500,
  }
}

export interface TopicConfig {
  title: string
  body?: string
  options: string[]
  /** Result tallies per option; omit for an un-tallied (upcoming/active) topic. */
  tallies?: number[]
}

/** Per-account state within one period. */
export interface AccountState {
  /** Registry xGov voting power (also the default eligibility gate). */
  power?: number
  /** Active-window `canVote` flag; defaults to `power > 0`. */
  canVote?: boolean
  /** `canVote` voting power as bigint; defaults to `BigInt(power)`. */
  votingPower?: bigint
  /** Per-topic per-option allocations; present = this account voted. */
  voteRecord?: number[][]
  /** Marks a delegator that voted directly (delegate can't override). */
  isDelegated?: boolean
  /** Producer rank for the "Top N% of producers" tag. */
  producerRank?: ProducerRank
}

export interface PeriodConfig {
  id: number
  phase: Phase
  ready?: boolean
  electSeats?: number
  title?: string
  body?: string
  topics?: TopicConfig[]
  committeeId?: Uint8Array
  committee?: { totalMembers?: number; totalVotes?: number; periodStart?: number; periodEnd?: number }
  voters?: string[]
  appId?: bigint | number
  /** Eligibility/power/records keyed by account address. */
  accounts?: Record<string, AccountState>
}

/**
 * Assemble a full {@link MockScenario} from a list of period configs. Fills the
 * period list, per-period detail (period/body/topic bodies/voters), one committee
 * per period, and — for every configured account — its voting power, eligibility,
 * vote record and producer rank. This single builder backs the landing, index and
 * detail stories.
 */
export function buildScenario(
  periods: PeriodConfig[],
  opts?: { globalLastPeriodId?: number; delegations?: Array<[string, string]>; flags?: MockScenario['flags'] },
): MockScenario {
  const scenario: MockScenario = {
    periods: [],
    periodDetail: {},
    committees: {},
    delegations: opts?.delegations ?? [],
    canVote: {},
    voteRecords: {},
    votingPowers: {},
    producerRanks: {},
    globalState: {
      lastPeriodId: BigInt(opts?.globalLastPeriodId ?? Math.max(0, ...periods.map((p) => p.id))),
    },
    flags: opts?.flags,
  }

  for (const cfg of periods) {
    const committeeId = cfg.committeeId ?? makeCommitteeId(cfg.id)
    const committeeB64 = toBase64Url(committeeId)
    const { votingStart, votingEnd } = windowFor(cfg.phase)
    const topicConfigs = cfg.topics ?? [{ title: 'Proposal', body: 'A sample topic.', options: ['Yes', 'No'] }]

    const period: GGovPeriod = {
      committeeId,
      votingStart,
      votingEnd,
      topics: topicConfigs.map((t) => makeTopic(t.options, t.tallies)),
    }

    scenario.periods.push({ id: cfg.id, ready: cfg.ready ?? true, period })

    scenario.periodDetail[cfg.id] = {
      period,
      body: makePeriodBody(cfg.title ?? `Period ${cfg.id}`, cfg.body ?? 'A sample governance period.', cfg.electSeats),
      topicBodies: topicConfigs.map((t) => ({ title: t.title, body: t.body ?? '' })),
      voters: cfg.voters ?? [],
      appId: cfg.appId ?? 1000 + cfg.id,
    }

    scenario.committees[committeeB64] = makeCommittee(committeeId, cfg.committee)

    for (const [address, state] of Object.entries(cfg.accounts ?? {})) {
      const power = state.power ?? 0
      scenario.votingPowers[cakey(committeeB64, address)] = power
      scenario.canVote[pakey(cfg.id, address)] = {
        canVote: state.canVote ?? power > 0,
        votingPower: state.votingPower ?? BigInt(power),
      }
      if (state.voteRecord) {
        scenario.voteRecords[pakey(cfg.id, address)] = {
          isDelegated: state.isDelegated ?? false,
          topicVotes: state.voteRecord,
        }
      } else {
        scenario.voteRecords[pakey(cfg.id, address)] = null
      }
      if (state.producerRank) scenario.producerRanks![cakey(committeeB64, address)] = state.producerRank
    }
  }

  return scenario
}

// --- Shared fixtures ---------------------------------------------------------

export const [alice, bob, carol] = demoAccounts
const rank = (topPercentile: number, rankPos = 12, totalMembers = 1240, votes = 4200): ProducerRank => ({
  rank: rankPos,
  totalMembers,
  votes,
  topPercentile,
})

/** Three-topic reward-policy ballot reused across landing/index/detail stories. */
export const SAMPLE_TOPICS: TopicConfig[] = [
  {
    title: 'Block reward policy',
    body: 'Should the per-block reward rate change for the next window?',
    options: ['Increase rewards', 'Keep rewards flat', 'Decrease rewards'],
  },
  {
    title: 'Treasury allocation',
    body: 'How should the ecosystem treasury be allocated this period?',
    options: ['Grants', 'Liquidity', 'Buyback'],
  },
]

export const SAMPLE_TOPICS_TALLIED: TopicConfig[] = [
  { ...SAMPLE_TOPICS[0], tallies: [52_000, 21_000, 11_500] },
  { ...SAMPLE_TOPICS[1], tallies: [38_000, 30_500, 16_000] },
]

/**
 * Election ballot: one topic PER candidate, each a Yes/No/Abstain vote.
 * The results page derives a net score (Yes − No) per candidate via
 * `tallyBallot` and ranks them; `electSeats` is the seat cutoff. Carries tallies so
 * the (live or final) ranked results render. Candidate name = the topic-body title.
 */
const candidate = (name: string, yes: number, no: number, abstain: number): TopicConfig => ({
  title: name,
  body: 'Candidate for a governance council seat.',
  options: ['Yes', 'No', 'Abstain'],
  tallies: [yes, no, abstain],
})

export const ELECTION_TOPICS: TopicConfig[] = [
  candidate('Alice Acharya', 42_000, 6_000, 3_000),
  candidate('Bob Bauer', 38_000, 9_000, 2_500),
  candidate('Carol Chen', 31_000, 14_000, 4_000),
  candidate('Dave Diaz', 19_000, 22_000, 5_000),
  candidate('Erin Engel', 12_000, 28_000, 6_000),
]

// --- Page presets ------------------------------------------------------------

/** Landing/index list with one period of every phase (alice connected & eligible). */
export function listScenario(opts: { connected?: boolean; account?: string } = {}): MockScenario {
  const account = opts.account ?? alice.address
  const accounts = (opts.connected ?? true) ? { [account]: { power: 4200, producerRank: rank(4) } } : {}
  return buildScenario(
    [
      {
        id: 9,
        phase: 'active',
        title: 'Period 9 · Reward policy',
        body: 'The active reward-policy vote.',
        topics: SAMPLE_TOPICS,
        accounts,
      },
      { id: 8, phase: 'upcoming', title: 'Period 8 · Treasury direction', body: 'Opens soon.', topics: SAMPLE_TOPICS },
      {
        id: 7,
        phase: 'ended',
        title: 'Period 7 · Protocol upgrade',
        body: 'Closed last week.',
        topics: SAMPLE_TOPICS_TALLIED,
        committee: { totalVotes: 84_500 },
      },
      {
        id: 6,
        phase: 'ended',
        title: 'Period 6 · Grants framework',
        body: 'An earlier closed period.',
        topics: SAMPLE_TOPICS_TALLIED,
      },
    ],
    { globalLastPeriodId: 9 },
  )
}

export interface DetailOptions {
  periodId?: number
  phase: Phase
  account?: string
  connected?: boolean
  /** Account is eligible (has voting power). Default true when connected. */
  eligible?: boolean
  /** Account already voted (seeds a vote record). */
  voted?: boolean
  electSeats?: number
  /** Delegators that point at `account` (shown nested in the selector). */
  delegators?: Array<{ address: string; power?: number; voted?: boolean; votedDirectly?: boolean }>
}

/** Full detail-page scenario for one period with eligibility/vote permutations. */
export function detailScenario(o: DetailOptions): MockScenario {
  const id = o.periodId ?? 7
  const account = o.account ?? alice.address
  const connected = o.connected ?? true
  const eligible = o.eligible ?? connected
  const tallied = o.phase === 'ended'
  const topics = tallied ? SAMPLE_TOPICS_TALLIED : SAMPLE_TOPICS
  const allOptionCounts = topics.map((t) => t.options.length)

  const accounts: Record<string, AccountState> = {}
  const voters: string[] = []
  const delegations: Array<[string, string]> = []

  if (connected) {
    const power = eligible ? 4200 : 0
    const voteRecord =
      o.voted && eligible
        ? allOptionCounts.map((n) => Array.from({ length: n }, (_, i) => (i === 0 ? power : 0)))
        : undefined
    accounts[account] = {
      power,
      canVote: o.phase === 'active' && eligible,
      votingPower: BigInt(power),
      voteRecord,
      producerRank: eligible ? rank(4) : undefined,
    }
    if (voteRecord) voters.push(account)

    for (const d of o.delegators ?? []) {
      const dPower = d.power ?? 2100
      const dVoted = d.voted || d.votedDirectly
      const dRecord = dVoted
        ? allOptionCounts.map((n) => Array.from({ length: n }, (_, i) => (i === 1 ? dPower : 0)))
        : undefined
      accounts[d.address] = {
        power: dPower,
        canVote: o.phase === 'active' && !d.votedDirectly,
        votingPower: BigInt(dPower),
        voteRecord: dRecord,
        // A delegator that voted directly cannot be overridden by its delegate.
        isDelegated: d.votedDirectly ? false : true,
        producerRank: rank(18),
      }
      delegations.push([d.address, account])
      if (dRecord) voters.push(d.address)
    }
  }

  return buildScenario(
    [
      {
        id,
        phase: o.phase,
        title: `Period ${id} · Reward policy`,
        body: 'This period asks governors to weigh in on the protocol reward schedule and treasury direction for the next window. Each topic below can be voted independently.',
        electSeats: o.electSeats,
        topics,
        voters,
        accounts,
      },
    ],
    { globalLastPeriodId: id, delegations },
  )
}

/**
 * Unified default scenario driven by the toolbar `auth` + `periodPhase` globals,
 * consumed by every playground story (landing, vote index, vote detail). The list
 * is composed so the *featured* period matches the phase, mirroring the app's
 * priority (active › upcoming › ended):
 *   - 'active'   → an active period exists (plus an upcoming and a past one)
 *   - 'upcoming' → NO active period, but an upcoming one (plus a past one)
 *   - 'ended'    → only past periods (NO active or upcoming)
 *
 * Period 7 always carries `phase`: it's the featured/context period for the list
 * pages and the single period the detail playground renders (routeParams `7`).
 */
export function defaultScenarioFromGlobals(auth: string, phase: string, election = false): MockScenario {
  const p = (phase === 'upcoming' || phase === 'ended' ? phase : 'active') as Phase
  const connected = auth !== 'disconnected'
  const power = 4200

  // Election periods carry `electSeats` (drives the detail page's "Election seats" /
  // "View Ranked Results" UI and the results page's ranked layout) plus an
  // election-flavoured title + per-candidate topics. The title is visible on the
  // landing hero and the index row too, so the toggle shows on all four pages.
  const featured: PeriodConfig = {
    id: 7,
    phase: p,
    title: election ? 'Period 7 · Council election' : 'Period 7 · Reward policy',
    body: election
      ? 'Elect the next governance council — vote Yes/No/Abstain on each candidate; the top 3 are seated.'
      : 'Weigh in on the protocol reward schedule and treasury direction for the next window.',
    electSeats: election ? 3 : undefined,
    topics: election ? ELECTION_TOPICS : p === 'ended' ? SAMPLE_TOPICS_TALLIED : SAMPLE_TOPICS,
    committee: p === 'ended' || election ? { totalVotes: 84_500 } : undefined,
    accounts: connected
      ? { [alice.address]: { power, canVote: p === 'active', votingPower: BigInt(power), producerRank: rank(4) } }
      : {},
  }

  // Lower-id context periods so period 7 stays the featured/most-recent one, while
  // never introducing a higher-priority phase than the requested one.
  const past: PeriodConfig = {
    id: 5,
    phase: 'ended',
    title: 'Period 5 · Protocol upgrade',
    topics: SAMPLE_TOPICS_TALLIED,
  }
  const context: PeriodConfig[] =
    p === 'active'
      ? [{ id: 6, phase: 'upcoming', title: 'Period 6 · Treasury direction', topics: SAMPLE_TOPICS }, past]
      : [past]

  return buildScenario([featured, ...context], { globalLastPeriodId: 7 })
}

/** Empty scenario (no periods) — list "empty" states. */
export const emptyScenario: MockScenario = buildScenario([], { globalLastPeriodId: 0 })
