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
import type { GGovPeriod, GGovVoteRecord, Election, PeriodBodyJson, TopicBodyJson } from 'ggov-sdk'
import type { PeriodWithId, CommitteeOption, ProducerRank } from '../../src/hooks/queries'
import type { PooledPosition } from '../../src/hooks/fracQueries'
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
      topicBodies: (TopicBodyJson | null)[]
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
  /** Registry voting power per `${committeeB64}:${account}` (`useGovVotingPowers`). */
  votingPowers: Record<string, number>
  /**
   * Pooled (fractional-delegation) positions per `${committeeB64}:${account}` —
   * drives `usePooledPositions`. Omit for accounts in no pool; a present-but-empty
   * array still marks the account a pool member, which is what the merged
   * voting-power card commits its layout on.
   */
  pooled?: Record<string, MockPooledPosition[]>
  /** Producer rank per `${committeeB64}:${account}` (`useProducerRank`). */
  producerRanks?: Record<string, ProducerRank | null>
  /**
   * Escrow app id per account (`useAppEscrow`). An account listed here is an
   * application's escrow, which the account page titles "Application Account".
   */
  appEscrows?: Record<string, bigint>
  /** Global registry state (`useGlobalState`, PeriodStatsCard). */
  globalState?: { lastPeriodId?: bigint }
  /** Force loading/error UIs without real async. */
  flags?: {
    periodsLoading?: boolean
    periodLoading?: boolean
    periodsError?: boolean
    /**
     * Pool membership known but amounts still resolving — the state where the
     * merged voting-power card shows its pooled chrome with skeleton amounts.
     */
    pooledLoading?: boolean
    /** Account page: the delegation card / delegator list / vote history skeletons. */
    delegationLoading?: boolean
    delegatorsLoading?: boolean
    votesLoading?: boolean
  }
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

export function makePeriodBody(title: string, body: string, elect?: Election[]): PeriodBodyJson {
  return elect !== undefined ? { title, body, elect } : { title, body }
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
  /** Election index this candidate runs in (`TopicBodyJson.e`); omit on standard topics. */
  e?: number
}

/**
 * A pooled position in a scenario, plus the ballot-only state the vote page needs.
 * The extra fields are ignored by the account-page surfaces (which only read
 * `PooledPosition`), so one fixture drives both.
 */
export type MockPooledPosition = PooledPosition & {
  /**
   * Pool-wide member count for the committee. Fixtures are keyed by account, so
   * without this a pool has as many "members" as the story gave it accounts —
   * fine for a card, misleading on the pools index. Set it to the figure the
   * registry would report.
   */
  poolMembers?: number
  /**
   * AlgoQuarters in the pool that have cast an internal ballot — the pools
   * index's turnout column. Defaults to summing the fixture's own `voteRecord`s,
   * which only reaches pool-scale numbers if the story defines pool-scale accounts.
   */
  poolVotedAq?: number
  /** Ballot eligibility (the contract's `canVote`); defaults to true. */
  canVote?: boolean
  /** Recorded pooled ballot, [topic][option] AlgoQuarters; present = this position voted. */
  voteRecord?: number[][]
  /** The owner cast it directly, so a delegate can't override. */
  votedDirectly?: boolean
  /** Has stake, but the pool hasn't synced this period / is still ingesting AQ. */
  poolNotReady?: boolean
}

/** Per-account state within one period. */
export interface AccountState {
  /** Registry gov voting power (also the default eligibility gate). */
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
  /**
   * Pooled positions this account holds in the period's committee. An empty array
   * still marks the account a pool member — useful for the "member, amounts not in
   * yet" state the merged voting-power card renders with skeletons.
   */
  pooled?: MockPooledPosition[]
}

export interface PeriodConfig {
  id: number
  phase: Phase
  ready?: boolean
  /** Elections this period runs; presence makes it an election period. */
  elect?: Election[]
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
  opts?: {
    globalLastPeriodId?: number
    delegations?: Array<[string, string]>
    /** Accounts that are application escrows, mapped to their owning app id. */
    appEscrows?: Record<string, bigint | number>
    flags?: MockScenario['flags']
  },
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
    pooled: {},
    appEscrows: Object.fromEntries(
      Object.entries(opts?.appEscrows ?? {}).map(([address, appId]) => [address, BigInt(appId)]),
    ),
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

    scenario.periods.push({ id: cfg.id, ready: cfg.ready ?? true, period, appId: BigInt(cfg.appId ?? 1000 + cfg.id) })

    scenario.periodDetail[cfg.id] = {
      period,
      body: makePeriodBody(cfg.title ?? `Period ${cfg.id}`, cfg.body ?? 'A sample governance period.', cfg.elect),
      topicBodies: topicConfigs.map((t) => ({
        title: t.title,
        body: t.body ?? '',
        ...(t.e !== undefined ? { e: t.e } : {}),
      })),
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
      if (state.pooled) scenario.pooled![cakey(committeeB64, address)] = state.pooled
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
 * Election ballot: one topic PER candidate, each a Support/Veto/Abstain vote.
 * The results page derives a net score (Support − Veto) per candidate via
 * `tallyBallot`, buckets candidates by their `e` tag and ranks each election
 * separately against its own seat count. Carries tallies so the (live or final)
 * ranked results render. Candidate name = the topic-body title.
 */
const candidate = (
  name: string,
  support: number,
  veto: number,
  abstain: number,
  e = 0,
  seat = 'a governance council seat',
): TopicConfig => ({
  title: name,
  body: `Candidate for ${seat}.`,
  options: ['Support', 'Veto', 'Abstain'],
  tallies: [support, veto, abstain],
  e,
})

/** One council election with 3 seats — the single-election shape. */
export const COUNCIL_ELECTION: Election[] = [{ t: 'Governance council', s: 3 }]

export const ELECTION_TOPICS: TopicConfig[] = [
  candidate('Alice Acharya', 42_000, 6_000, 3_000),
  candidate('Bob Bauer', 38_000, 9_000, 2_500),
  candidate('Carol Chen', 31_000, 14_000, 4_000),
  candidate('Dave Diaz', 19_000, 22_000, 5_000),
  candidate('Erin Engel', 12_000, 28_000, 6_000),
]

/** Two elections on one shared ballot — candidates split across them by `e`. */
export const MULTI_ELECTIONS: Election[] = [
  { t: 'Governance council', s: 3 },
  { t: 'Treasury committee', s: 2 },
]

const treasurySeat = 'a treasury committee seat'

export const MULTI_ELECTION_TOPICS: TopicConfig[] = [
  candidate('Alice Acharya', 42_000, 6_000, 3_000),
  candidate('Bob Bauer', 38_000, 9_000, 2_500),
  candidate('Carol Chen', 31_000, 14_000, 4_000),
  candidate('Dave Diaz', 19_000, 22_000, 5_000),
  candidate('Frank Fischer', 36_000, 7_500, 2_000, 1, treasurySeat),
  candidate('Grace Gallo', 29_000, 11_000, 3_500, 1, treasurySeat),
  candidate('Hana Haddad', 24_000, 18_000, 4_500, 1, treasurySeat),
]

// --- Page presets ------------------------------------------------------------

/** Landing/index list with one period of every phase (alice connected & eligible). */
/**
 * Two pooled positions for the stories that exercise pooled voting: a liquid-staking
 * token and a Réti pool, with the shares/AQ that produce "≈ 5,820.44 via 2 pools".
 * `votes` is `userAq / totalAq * poolVotes`, as the real hook derives it.
 */
export const SAMPLE_POOLED: PooledPosition[] = [
  {
    instanceNumId: 1,
    instanceName: 'Folks Finance xALGO',
    userAq: 4_120,
    totalAq: 512_400,
    sharePct: (4_120 / 512_400) * 100,
    poolVotes: 509_800,
    votes: (4_120 / 512_400) * 509_800,
  },
  {
    instanceNumId: 2,
    instanceName: 'Réti pool #42',
    userAq: 1_730,
    totalAq: 91_050,
    sharePct: (1_730 / 91_050) * 100,
    poolVotes: 90_600,
    votes: (1_730 / 91_050) * 90_600,
  },
]

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
      // One of each election shape, so the list's ballot column shows every label
      // it can produce: "2 elections", "5 candidates" and "2 topics".
      {
        id: 5,
        phase: 'ended',
        title: 'Period 5 · Term 2 elections',
        body: 'Council and treasury committee, elected together.',
        elect: MULTI_ELECTIONS,
        topics: MULTI_ELECTION_TOPICS,
      },
      {
        id: 4,
        phase: 'ended',
        title: 'Period 4 · Council election',
        body: 'A single-election period.',
        elect: COUNCIL_ELECTION,
        topics: ELECTION_TOPICS,
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
  /** Elections this period runs; presence makes it an election period. */
  elect?: Election[]
  /**
   * Ballot contents. Defaults to the standard reward-policy topics — pass the
   * election fixtures alongside `elect`, or the period is flagged an election
   * while its topics carry no `e` tag and every one reads as unassigned.
   */
  topics?: TopicConfig[]
  /** Period title; defaults to a reward-policy or council-election name to match `elect`. */
  title?: string
  /** Period body prose; defaults alongside {@link title}. */
  body?: string
  /** Delegators that point at `account` (shown nested in the selector). */
  delegators?: Array<{
    address: string
    power?: number
    voted?: boolean
    votedDirectly?: boolean
    /** This delegator's own pools — the two-levels-deep rows in the selector. */
    pooled?: MockPooledPosition[]
  }>
  /** Pooled positions `account` holds, nested under it in the selector. */
  pooled?: MockPooledPosition[]
}

/** Full detail-page scenario for one period with eligibility/vote permutations. */
export function detailScenario(o: DetailOptions): MockScenario {
  const id = o.periodId ?? 7
  const account = o.account ?? alice.address
  const connected = o.connected ?? true
  const eligible = o.eligible ?? connected
  const tallied = o.phase === 'ended'
  const topics = o.topics ?? (tallied ? SAMPLE_TOPICS_TALLIED : SAMPLE_TOPICS)
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
      pooled: o.pooled,
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
        pooled: d.pooled,
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
        title: o.title ?? (o.elect ? `Period ${id} · Council election` : `Period ${id} · Reward policy`),
        body:
          o.body ??
          (o.elect
            ? 'Governors rank the candidates standing in this period. Each is a Support / Veto / Abstain ballot; the highest net scores lead for the seats on offer.'
            : 'This period asks governors to weigh in on the protocol reward schedule and treasury direction for the next window. Each topic below can be voted independently.'),
        elect: o.elect,
        topics,
        voters,
        accounts,
      },
    ],
    { globalLastPeriodId: id, delegations },
  )
}

// --- Account page ------------------------------------------------------------

/** One committee window the viewed account appears in, newest first. */
export interface AccountPeriodConfig {
  /** Direct voting power from blocks the account produced in this committee. */
  power?: number
  /** Pooled positions held in this committee; present (even empty) = pool member. */
  pooled?: MockPooledPosition[]
  /** The account voted in this period — seeds a vote record ("Votes cast"). */
  voted?: boolean
  /** The vote was cast by a delegate ("↪ Voted by a delegate" tag). */
  votedByDelegate?: boolean
  /** Spread the vote across the first two options instead of all on the first. */
  split?: boolean
  phase?: Phase
  title?: string
}

export interface AccountOptions {
  /** Address the page is viewing (the `address` route param). */
  account?: string
  /** Committee windows / periods for this account, newest first. */
  periods?: AccountPeriodConfig[]
  /** Address this account delegates its voting power to. */
  delegatesTo?: string
  /** Accounts that delegate their voting power to this account. */
  delegators?: string[]
  /** Owning app id — makes the page render as an "Application Account". */
  appEscrow?: bigint | number
  flags?: MockScenario['flags']
}

const ACCOUNT_PERIOD_TITLES = ['Reward policy', 'Treasury direction', 'Protocol upgrade', 'Grants framework']

/**
 * Account-page scenario: a per-committee power history for one account, plus its
 * delegation, incoming delegators and vote history.
 *
 * Every committee is carried by a period (that's how {@link buildScenario} models
 * them), so one entry in `periods` is both a committee window on the voting-power
 * card and a candidate row in "Votes cast". Ids/block windows descend from the
 * newest entry, so index 0 is the current committee.
 */
export function accountScenario(o: AccountOptions = {}): MockScenario {
  const account = o.account ?? alice.address
  const configs = o.periods ?? [{ power: 12_480, voted: true }, { power: 11_920, voted: true }, { power: 9_640 }]

  const periods: PeriodConfig[] = configs.map((cfg, i) => {
    const id = 9 - i
    const phase = cfg.phase ?? (i === 0 ? 'active' : 'ended')
    const topics = phase === 'ended' ? SAMPLE_TOPICS_TALLIED : SAMPLE_TOPICS
    const power = cfg.power ?? 0
    const voted = !!cfg.voted || !!cfg.votedByDelegate
    // A pool member votes with its pooled share, so a ballot is weighted by whichever
    // power the account actually has. It must be non-zero: "Votes cast" hides every
    // all-zero topic, which would otherwise render as an empty card.
    const ballotWeight = Math.round(power || (cfg.pooled ?? []).reduce((sum, p) => sum + p.votes, 0)) || 1
    // The card reads each topic's percentage off the account's own allocation, so
    // an all-on-one-option record reads "100.0%" and a split one reads "N votes".
    const voteRecord = voted
      ? topics.map((t) =>
          Array.from({ length: t.options.length }, (_, oi) => {
            if (cfg.split)
              return oi === 0 ? Math.round(ballotWeight * 0.6) : oi === 1 ? Math.round(ballotWeight * 0.4) : 0
            return oi === 0 ? ballotWeight : 0
          }),
        )
      : undefined

    return {
      id,
      phase,
      title: `Period ${id} · ${cfg.title ?? ACCOUNT_PERIOD_TITLES[i % ACCOUNT_PERIOD_TITLES.length]}`,
      topics,
      committee: { periodStart: 48_200_000 - i * 3_200_000, periodEnd: 51_200_000 - i * 3_200_000 },
      voters: voted ? [account] : [],
      accounts: {
        [account]: {
          power,
          votingPower: BigInt(power),
          voteRecord,
          isDelegated: cfg.votedByDelegate,
          ...(cfg.pooled ? { pooled: cfg.pooled } : {}),
        },
      },
    }
  })

  const delegations: Array<[string, string]> = [
    ...(o.delegatesTo ? ([[account, o.delegatesTo]] as Array<[string, string]>) : []),
    ...(o.delegators ?? []).map((d): [string, string] => [d, account]),
  ]

  return buildScenario(periods, {
    globalLastPeriodId: 9,
    delegations,
    appEscrows: o.appEscrow != null ? { [account]: o.appEscrow } : undefined,
    flags: o.flags,
  })
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

  // Election periods carry `elect` (drives the detail page's "Election seats" /
  // "View Ranked Results" UI and the results page's ranked layout) plus an
  // election-flavoured title + per-candidate topics. The title is visible on the
  // landing hero and the index row too, so the toggle shows on all four pages.
  const featured: PeriodConfig = {
    id: 7,
    phase: p,
    title: election ? 'Period 7 · Council election' : 'Period 7 · Reward policy',
    body: election
      ? 'Elect the next governance council — vote Support/Veto/Abstain on each candidate; the top 3 are seated.'
      : 'Weigh in on the protocol reward schedule and treasury direction for the next window.',
    elect: election ? COUNCIL_ELECTION : undefined,
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
