import { Account, Application, uint64 } from '@algorandfoundation/algorand-typescript'
import { StaticBytes, Uint16, Uint32, Uint8 } from '@algorandfoundation/algorand-typescript/arc4'
import { u16, u32 } from './utils.algo'

export type CommitteeId = StaticBytes<32>

export type GGovAccount = {
  /** Account ID */
  accountId: Uint32
  /** Committee superbox offsets for the account */
  committeeOffsets: [Uint16, Uint16][] // [committee numeric id, account offset]
}

/**
 * Committee Metadata
 */
export type CommitteeMetadata = {
  numericId: Uint16
  periodStart: Uint32
  periodEnd: Uint32 // exclusive
  totalMembers: Uint32
  totalVotes: Uint32
  xGovRegistryId: uint64
  ingestedVotes: Uint32
}

export type CommitteeNumIdAccountId = [Uint16, Uint16] // [committee numeric id, accountId]

/**
 * Empty/"not found" committee metadata. `numericId` 0 is never assigned by the registry
 * (`lastCommitteeId` starts at 1), so it doubles as a "no such committee" sentinel.
 */
export function getEmptyCommitteeMetadata(): CommitteeMetadata {
  return {
    periodStart: u32(0),
    periodEnd: u32(0),
    totalMembers: u32(0),
    totalVotes: u32(0),
    xGovRegistryId: 0,
    ingestedVotes: u32(0),
    numericId: u16(0),
  }
}

/**
 * Input representation of a committee member (gov)
 */
export type AccountWithVotes = {
  account: Account
  votes: Uint32
}

/**
 * Stored representation of a committee member (gov)
 */
export type AccountIdWithVotes = {
  accountId: Uint32
  votes: Uint32
}

export const ACCOUNT_ID_WITH_VOTES_STORED_SIZE: uint64 = 4 + 4 // AccountID + Votes

export type AlgohourAccountKey = [uint64, Uint32]

export type AccountAlgohourInput = {
  account: Account
  hours: uint64
}

export type AccountWithOffsetHint = {
  account: Account
  offsetHint: Uint32
}

export type AlgohourPeriodTotals = {
  totalAlgohours: uint64
  final: boolean
}

export type DelegatorCommittee = {
  periodStart: Uint32
  periodEnd: Uint32
  extDelegatedVotes: Uint32
  extDelegatedAccountVotes: AccountIdWithVotes[]
}

export function getEmptyDelegatorCommittee(): DelegatorCommittee {
  return {
    periodStart: u32(0),
    periodEnd: u32(0),
    extDelegatedVotes: u32(0),
    extDelegatedAccountVotes: [] as AccountIdWithVotes[],
  }
}

export type DelegatorProposalStatus = 'WAIT' | 'VOTE' | 'VOTD' | 'CANC'

export type DelegatorProposal = {
  status: DelegatorProposalStatus

  committeeId: CommitteeId

  extVoteStartTime: Uint32
  extVoteEndTime: Uint32
  extTotalVotingPower: Uint32
  extAccountsPendingVotes: AccountIdWithVotes[]
  extAccountsVoted: AccountIdWithVotes[]

  intVoteEndTime: Uint32

  intTotalAlgohours: uint64
  intVotedAlgohours: uint64

  intVotesYesAlgohours: uint64
  intVotesNoAlgohours: uint64
  intVotesAbstainAlgohours: uint64
  intVotesBoycottAlgohours: uint64
}

export function getEmptyDelegatorProposal(): DelegatorProposal {
  return {
    status: '' as DelegatorProposalStatus,
    committeeId: new StaticBytes<32>(),
    extVoteStartTime: u32(0),
    extVoteEndTime: u32(0),
    extTotalVotingPower: u32(0),
    extAccountsPendingVotes: [] as AccountIdWithVotes[],
    extAccountsVoted: [] as AccountIdWithVotes[],
    intVoteEndTime: u32(0),
    intTotalAlgohours: 0,
    intVotedAlgohours: 0,
    intVotesYesAlgohours: 0,
    intVotesNoAlgohours: 0,
    intVotesAbstainAlgohours: 0,
    intVotesBoycottAlgohours: 0,
  }
}

export type DelegatorVote = {
  yesVotes: uint64
  noVotes: uint64
  abstainVotes: uint64
  boycottVotes: uint64
}

// gGov types

/** Summary of a period stored on the registry side. Kept in sync by the period contract via updatePeriodSummary. */
export type GGovPeriodSummary = {
  appId: uint64
  votingStart: Uint32
  votingEnd: Uint32
  numTopics: Uint32
  ready: boolean
}

export function getEmptyGGovPeriodSummary(): GGovPeriodSummary {
  return {
    appId: 0,
    votingStart: u32(0),
    votingEnd: u32(0),
    numTopics: u32(0),
    ready: false,
  }
}

/** Topic options — stored in topicOptionsArr; mutated only during editable phase. */
export type GGovTopicOptions = {
  options: string[] // we have a tiny penalty in opcode + on-chain storage for storing this as a struct instead of bare string[], but we prefer the shape safety and readability of a struct with a named field over a bare array
}

/** Topic vote tallies — stored in topicVotesArr; mutated on every vote(). */
export type GGovTopicVotes = {
  votes: Uint32[] // same choice as GGovTopicOptions
}

/** Merged read shape returned by GGovPeriod.getPeriod(). Composed from GGovTopicOptions and GGovTopicVotes. */
export type GGovTopic = {
  options: string[]
  votes: Uint32[]
}

/** Period - stored in BoxMap<Uint32, GGovPeriod>. Not always safe to return as ABI, can exceed 1KB */
export type GGovPeriod = {
  committeeId: CommitteeId
  votingStart: Uint32
  votingEnd: Uint32
  topics: GGovTopic[]
}

/** Period short - used by fractional delegator */
export type GGovPeriodShort = {
  committeeId: CommitteeId
  votingStart: Uint32
  votingEnd: Uint32
  topicOptionLengths: Uint32[]
}

/**
 * Period header, logged as the first line by GGovPeriod.logPeriod() — the non-topic
 * fields of GGovPeriod plus the topic count. Each subsequent log line is one GGovTopic.
 * Lets readers reconstruct the full period without GGovPeriod's single-log size cap.
 */
export type GGovPeriodMeta = {
  committeeId: CommitteeId
  votingStart: Uint32
  votingEnd: Uint32
  numTopics: Uint32
}

/** Vote record per account per period */
export type GGovVoteRecord = {
  isDelegated: boolean
  topicVotes: Uint32[][]
}

/**
 * Vote-record header, logged as the first line by GGovPeriod.logVotingRecord() — the
 * non-topic fields of GGovVoteRecord plus the topic count. Each subsequent log line is one
 * topic's Uint32[] votes (wrapped as GGovTopicVotes). Mirrors GGovPeriodMeta/logPeriod: lets
 * readers reconstruct the full record without GGovVoteRecord's single-log size cap, which
 * getVotingRecord() overflows once topicVotes grows large.
 */
export type GGovVoteRecordMeta = {
  isDelegated: boolean
  numTopics: Uint32
}

export function getEmptyGGovPeriod(): GGovPeriod {
  return {
    committeeId: new StaticBytes<32>(),
    votingStart: u32(0),
    votingEnd: u32(0),
    topics: [] as GGovTopic[],
  }
}

export function getEmptyGGovPeriodShort(): GGovPeriodShort {
  return {
    committeeId: new StaticBytes<32>(),
    votingStart: u32(0),
    votingEnd: u32(0),
    topicOptionLengths: [] as Uint32[],
  }
}

export function getEmptyGGovVoteRecord(): GGovVoteRecord {
  return {
    isDelegated: false,
    topicVotes: [] as Uint32[][],
  }
}

/*
 * ARC-28 events. Field order is significant: it defines the on-chain event ABI, so append new
 * fields rather than reordering. The type name is the event name used to derive the 4-byte prefix.
 */

/** Emitted by GGovPeriod.vote() whenever a vote is cast or updated. IMPORTANT: Size must be kept in sync with Period.setReady calculations */
export type GGovVoteCast = {
  /** Account whose voting power was cast */
  voter: Account
  /** Transaction sender: equals `voter` for self-votes, the delegatee for delegated votes */
  sender: Account
  // isDelegated is not logged, implicit from voter != sender
  /** Whether this is an update to an existing vote (true) or the first vote (false) */
  updateVote: boolean
  /** Total voting power applied (sum of every option across every topic) */
  votingPower: uint64
  /** Votes cast this call per topic, parallel to the period's topics/options */
  topicVotes: Uint32[][]
  // not adding global vote state intentionally, it would limit the number of topics/options we can support (via 1KB log limit)
}

/** Emitted by GGovRegistry when a delegation is first set or changed (delegator → delegatee). previousDelegate will be zero address when setting delegation for the first time. */
export type GGovDelegationSet = {
  delegator: Account
  previousDelegatee: Account
  delegatee: Account
}

/** Emitted by GGovRegistry when a delegation is cleared. */
export type GGovDelegationCleared = {
  delegator: Account
  /** Delegatee the delegation pointed at before being cleared */
  previousDelegatee: Account
}

/** Account stored in Fractional Delegation Registry */
export type FracRegAccount = {
  /** Short incremental account ID */
  accountId: Uint32
  /** numeric IDs of all frac instances this account appears in */
  instanceNumIds: Uint16[]
}

/** Frac Registry representation of Frac Instances */
export type FracInstance = {
  appId: Application
  name: string
  numAccounts: uint64
  numEscrows: uint64
  // forgetting one here
}

/**
 * A Frac Instance's synced snapshot of one gGov committee, written by `syncCommittee`.
 *
 * `escrowsVotes` is index-synced with the instance's `escrows` box: `escrowsVotes[i]` is the gGov
 * voting power of `escrows[i]` in this committee, and is 0 for an escrow that is not a member.
 * Because `escrows` is append-only, indexes stay stable across re-syncs.
 */
export type FracInstanceCommittee = {
  /** Committee numeric ID, as assigned by the gGov registry */
  committeeNumId: Uint16
  /** gGov voting power per escrow, index-synced with the instance's `escrows` box */
  escrowsVotes: Uint32[]
  /** Sum of `escrowsVotes` */
  totalVotes: Uint32
}

/**
 * A Frac Instance's synced snapshot of one gGov period, written by `syncPeriod`.
 *
 * `committeeNumId` is copied from the instance's local `committees` box rather than re-read from
 * the gGov registry, which is what keeps `syncPeriod` to a single inner call.
 *
 * `periodAppId` is a bare `uint64` rather than an `Application` on purpose: a struct holding a
 * reference-type field cannot be `clone()`d by algorand-typescript-testing 1.1.0, and `syncPeriod`
 * clones this struct.
 */
export type FracInstancePeriod = {
  /** The gGov period app this record was synced from */
  periodAppId: uint64
  committeeId: CommitteeId
  /** Committee numeric ID, copied from `FracInstanceCommittee.committeeNumId` */
  committeeNumId: Uint16
  /** Voting window start (unix seconds) */
  votingStart: Uint32
  /** Voting window end, exclusive (unix seconds) */
  votingEnd: Uint32
  /** Option count per topic, parallel to the period's topics */
  topicOptionLengths: Uint32[]
  /**
   * Number of `periodEscrowVotes` boxes stood up for this period - the escrow count of the
   * committee snapshot it was synced against. Recorded here so the record is self-describing:
   * re-syncing the committee alone can grow `escrowsVotes` past what this period has boxes for, so
   * readers must not size off the committee box.
   */
  numEscrows: Uint8
}

/**
 * A Frac Instance's aggregate vote tallies for one gGov period, zero-filled to the period's topic
 * shape by `syncPeriod`. Per-escrow detail lives in `FracEscrowVotes`, one box per escrow.
 *
 * Every tally is bounded by the committee's total votes, which the gGov registry itself caps at a
 * `Uint32` (`CommitteeMetadata.totalVotes`, enforced by `ingestedVotes <= totalVotes`). Real totals
 * are ~3M, so `Uint32` is ~1400x oversized already and `uint64` would only waste box space.
 *
 * SIZE: read and written whole via `.value`, so it is bounded by the AVM's 4096-byte stack-bytes
 * cap - NOT the 32KB box limit (see the paging comment in `FracDelegationRegistry.createInstance`).
 * Holding only the two aggregate tallies, it is `8 + 2 * (2 + 4*topics*(1 + options))`: ~1.9KB even
 * at the ~58 topics `GGovPeriod.setReady` allows, so the topic ceiling is the period's, not ours.
 */
export type FracPeriodVoteCache = {
  /** [topic][option] internal vote tally, in AlgoQuarters */
  internal: Uint32[][]
  /** [topic][option] cached total of external gGov votes cast by this instance's escrows */
  ggovTotals: Uint32[][]
}

/**
 * `periodEscrowVotes` box key: [gGov period ID, escrow index].
 *
 * `Uint8` bounds the escrow index at 255, which is never the binding constraint: the `escrows` box
 * is a `Box<Account[]>` whose whole-value read already stops decoding at ~127 entries (4096-byte
 * stack cap / 32 bytes per address).
 */
export type FracPeriodEscrowKey = [Uint32, Uint8]

/**
 * One escrow's external gGov votes for one gGov period, zero-filled to the period's topic shape by
 * `syncPeriod`. One box per (period, escrow).
 *
 * The escrow index is that of the `committees(committeeId).escrowsVotes` snapshot the period was
 * synced against - and so, transitively, of the append-only `escrows` box. An escrow registered
 * after the last `syncCommittee` has no snapshot and therefore no voting power to cast, so it gets
 * no box until the committee is re-synced and the period re-synced behind it.
 *
 * Split out of `FracPeriodVoteCache` rather than nested as a `Uint32[][][]`: one combined box is
 * capped at 4096 bytes by the stack-bytes limit above, which would have bounded the whole system to
 * ~31 topics at 6 escrows and ~21 at 10 - a ceiling that tightened as escrows were added. One box
 * per escrow is `2 + 4*topics*(1 + options)` (~930 bytes at 58 topics), so escrow count is
 * unbounded and each box stays far inside the cap.
 */
export type FracEscrowVotes = {
  /** [topic][option] external gGov votes cast by this escrow */
  votes: Uint32[][]
}
