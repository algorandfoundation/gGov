import { Account, Application, uint64 } from '@algorandfoundation/algorand-typescript'
import { StaticBytes, Uint16, Uint32, Uint8 } from '@algorandfoundation/algorand-typescript/arc4'
import { u16, u32, u8 } from './utils.algo'

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
}

/** An escrow's resolved instance assignment, returned by `FracDelegationRegistry.getEscrow`. */
export type FracEscrowInstance = {
  /** Numeric ID of the instance the escrow is registered to */
  instanceNumId: Uint16
  /** App ID of that instance */
  instanceAppId: uint64
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

/** Empty/"not synced" committee snapshot. `committeeNumId` 0 is never assigned by the gGov registry. */
export function getEmptyFracInstanceCommittee(): FracInstanceCommittee {
  return {
    committeeNumId: u16(0),
    escrowsVotes: [] as Uint32[],
    totalVotes: u32(0),
  }
}

/**
 * A Frac Instance's headline position in one gGov committee: what its synced snapshot says it is
 * worth, joined with the AlgoQuarters ledger backing it. Returned by
 * `FracDelegationInstance.getCommitteeStanding`.
 *
 * The two halves live in separate boxes keyed differently (`committees` by 32-byte committee ID,
 * `committeeAq` by the locally-synced numeric ID), so reading them apart costs a caller two
 * round-trips plus a join it cannot even start without the first result. This is that join, done
 * where both boxes already are.
 *
 * Deliberately excludes `FracInstanceCommittee.escrowsVotes`: it grows with the escrow count, and
 * this struct exists to be logged - one line per instance, against a 1024-byte log limit. Callers
 * that want the per-escrow breakdown want `getCommittee`.
 *
 * Two independent sentinels, inherited from the getters this composes:
 * - `committeeNumId` 0 - the instance has never `syncCommittee`'d this committee, so every other
 *   field is 0 as well (see `getEmptyFracInstanceCommittee`).
 * - `totalAq` 0 - no AlgoQuarters ledger is open, which is a *different* state from an unsynced
 *   committee: a committee can be synced (real `totalVotes`) with ingestion not yet started (see
 *   `getEmptyFracCommitteeAq`).
 */
export type FracCommitteeStanding = {
  /** Committee numeric ID as synced locally, or 0 if the committee is not synced */
  committeeNumId: Uint16
  /** The instance's gGov voting power in the committee (the snapshot's `totalVotes`) */
  totalVotes: Uint32
  /** The committee's declared total AlgoQuarters, 0 if no ledger is open */
  totalAq: Uint32
  /** AlgoQuarters ingested so far; equal to `totalAq` once ingestion is complete */
  ingestedAq: Uint32
  /** Accounts the ledger declares for the committee, 0 if no ledger is open */
  totalAccounts: Uint32
  /** Accounts whose AlgoQuarters are on chain, window-scoped (see `FracCommitteeAq.numAccounts`) */
  numAccounts: Uint32
}

/** Empty/"not synced" standing - both sentinels at once. */
export function getEmptyFracCommitteeStanding(): FracCommitteeStanding {
  return {
    committeeNumId: u16(0),
    totalVotes: u32(0),
    totalAq: u32(0),
    ingestedAq: u32(0),
    totalAccounts: u32(0),
    numAccounts: u32(0),
  }
}

/**
 * One frac instance's standing in one gGov committee, tagged with the instance's identity. Logged
 * per instance by `FracDelegationRegistry.logInstanceCommittees` so a caller can ask "which pools
 * hold power in this committee, and how much stake is behind it" in one paged simulate - instead of
 * listing instances, then reading each one's snapshot, then each one's ledger.
 *
 * The identity half (`instanceNumId`, `instanceAppId`, `instanceName`, `instanceNumAccounts`) is
 * supplied by the registry from its own `instances` box; the committee half is the
 * `FracCommitteeStanding` fetched from the instance, flattened in so the whole record is one ARC-4
 * tuple on the wire.
 *
 * `instanceNumAccounts` and `numAccounts` are different populations and both are wanted: the former
 * is the instance's live registry-wide roster, the latter is who actually held stake during this
 * committee's window.
 *
 * The committee ID is not echoed back - unlike `FracAccountCommitteeAq`, every record a given call
 * produces is about the single committee the caller named.
 */
export type FracInstanceCommitteeStanding = {
  /** Registry-assigned numeric ID of the instance */
  instanceNumId: Uint16
  /** On-chain app ID of the instance */
  instanceAppId: uint64
  /** Human-readable instance label */
  instanceName: string
  /** Accounts registered to the instance registry-wide - its live roster, not window-scoped */
  instanceNumAccounts: uint64
  /** Committee numeric ID as synced locally, or 0 if the committee is not synced */
  committeeNumId: Uint16
  /** The instance's gGov voting power in the committee */
  totalVotes: Uint32
  /** The committee's declared total AlgoQuarters, 0 if no ledger is open */
  totalAq: Uint32
  /** AlgoQuarters ingested so far */
  ingestedAq: Uint32
  /** Accounts the ledger declares for the committee */
  totalAccounts: Uint32
  /** Accounts whose AlgoQuarters are on chain for this committee */
  numAccounts: Uint32
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

/** Empty/"not synced" period snapshot. `periodAppId` 0 is never written by `syncPeriod`. */
export function getEmptyFracInstancePeriod(): FracInstancePeriod {
  return {
    periodAppId: 0,
    committeeId: new StaticBytes<32>(),
    committeeNumId: u16(0),
    votingStart: u32(0),
    votingEnd: u32(0),
    topicOptionLengths: [] as Uint32[],
    numEscrows: u8(0),
  }
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
 * Empty/"not synced" vote cache. A synced period fills `internal` to its topic shape (>= 1 topic),
 * so the empty top-level arrays are unambiguous as a "no period" sentinel for readers.
 */
export function getEmptyFracPeriodVoteCache(): FracPeriodVoteCache {
  return {
    internal: [] as Uint32[][],
    ggovTotals: [] as Uint32[][],
  }
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

/**
 * Empty/"no box" escrow votes. A synced period stands up one box per escrow filled to its topic
 * shape (>= 1 topic), so empty `votes` is unambiguous as a "no box" sentinel for readers.
 */
export function getEmptyFracEscrowVotes(): FracEscrowVotes {
  return {
    votes: [] as Uint32[][],
  }
}

/**
 * Input representation of an account's AlgoQuarters for a committee, as emitted by the off-chain
 * AlgoQuarters pipeline (`AlgoQuartersData.accounts`). Mirrors `AccountWithVotes`: the address-keyed
 * input form that `FracDelegationInstance.ingestAq` resolves into the account-ID-keyed stored form.
 */
export type AccountWithAq = {
  account: Account
  /** AlgoQuarters earned by the account over the committee's period. Must be greater than zero. */
  aq: Uint32
}

/**
 * `accountAq` box key: [frac registry account ID, gGov committee numeric ID].
 *
 * Keyed by the registry's numeric `accountId` rather than the 32-byte address: 4 bytes instead of 32
 * saves 11,200 microALGO of box MBR per entry, and `ingestAq` must call the registry anyway to
 * associate the account with the instance, so the ID costs nothing extra to obtain.
 */
export type FracAccountAqKey = [Uint32, Uint16]

/**
 * A Frac Instance's AlgoQuarters ledger for one gGov committee, opened by `startAqIngest` and
 * accumulated by `ingestAq`. Keyed by the committee's gGov numeric ID, copied out of the instance's
 * `committees` snapshot - so a ledger's existence already implies the committee was synced.
 *
 * `totalAq` is the off-chain pipeline's declared total for the committee's period
 * (`AlgoQuartersData.totalAlgoQuarters`); `ingestedAq` sums every `accountAq` box written so far.
 * `totalAccounts` is the parallel declared account count and `numAccounts` its running tally.
 * Ingestion is complete - and the committee votable - when BOTH `ingestedAq === totalAq` and
 * `numAccounts === totalAccounts`
 *
 * `totalAq` 0 is never written (`startAqIngest` rejects a zero total), so it doubles as a "no ledger
 * for this committee" sentinel
 *
 * `Uint32` is forced from both ends: the off-chain pipeline already asserts it per account
 * (`assertAlgoQuartersFitUint32`), and `FracPeriodVoteCache.internal` - the tally AQ votes land in -
 * is `Uint32[][]`. A tally is bounded by `totalAq`, so the two must share a width. Headroom is
 * thinner here than for the gGov vote totals this mirrors: realistic AQ totals run ~1e8-1e9 against
 * the 4.29e9 ceiling, not ~3e6.
 */
export type FracCommitteeAq = {
  /** Total AlgoQuarters declared for the committee's period. Greater than zero. */
  totalAq: Uint32
  /** Sum of every ingested account's AlgoQuarters. Never exceeds `totalAq`. */
  ingestedAq: Uint32
  /** Total number of accounts expected for the committee's period. Greater than zero. */
  totalAccounts: Uint32
  /**
   * Number of `accountAq` boxes standing for this committee. Accumulated by `ingestAq` and checked
   * against `totalAccounts`: a batch may never push it past the declared total, and
   * `getCommitteeAq(mustBeComplete)` requires the two to be equal.
   * `ingestedAq === 0` implies `numAccounts === 0`.
   */
  numAccounts: Uint32
}

/** Empty/"not found" AlgoQuarters ledger. `totalAq` 0 is never written by `startAqIngest`. */
export function getEmptyFracCommitteeAq(): FracCommitteeAq {
  return {
    totalAq: u32(0),
    ingestedAq: u32(0),
    totalAccounts: u32(0),
    numAccounts: u32(0),
  }
}

/**
 * `votingRecords` box key: [gGov period ID, frac registry account ID].
 *
 * Keyed by the registry's numeric account ID for the same reason `FracAccountAqKey` is: 4 bytes
 * instead of 32 of address, and `vote` resolves the voter through the registry anyway.
 */
export type FracPeriodAccountKey = [Uint32, Uint32]

/**
 * One account's internal vote for one gGov period, written by `vote`. The stored rows are exactly
 * what the account submitted - [topic][option] AlgoQuarters, each topic summing to the account's
 * full `accountAq` weight - so a re-vote can subtract them from `FracPeriodVoteCache.internal`
 * before the new rows are added, mirroring `GGovVoteRecord`.
 */
export type FracVotingRecord = {
  /**
   * True when the record was written by a delegatee on the voter's behalf (`Txn.sender !==
   * voterAccount`), false when the voter cast it themselves. Mirrors `GGovVoteRecord.isDelegated`,
   * and carries the same guard: a delegatee may not overwrite a record with `isDelegated === false`.
   */
  isDelegated: boolean
  /** [topic][option] internal votes, in AlgoQuarters */
  topicVotes: Uint32[][]
}

/**
 * Empty/"has not voted" record. A cast vote has one row per topic (>= 1 topic), so empty
 * `topicVotes` is unambiguous as a "no vote" sentinel for readers.
 */
export function getEmptyFracVotingRecord(): FracVotingRecord {
  return {
    isDelegated: false,
    topicVotes: [] as Uint32[][],
  }
}

/**
 * Bundled read of one account's AlgoQuarters standing in one committee of a frac instance, returned
 * by `FracDelegationInstance.getAccountCommitteeAq`. Joins the instance's identity, the committee's
 * identity, the account's own weight against the committee total, and the instance's gGov power in
 * that committee, in a single readonly call so a caller (e.g. a wallet showing "your voting weight
 * here") needs no follow-up lookups.
 *
 * `totalVotes` is the last piece needed to turn a weight into votes - a member's share is
 * `userAq / totalAq * totalVotes` - and it is free here: it lives in the same `committees` box the
 * getter already reads to resolve `committeeNumId`. Carrying it means a caller no longer pairs this
 * struct with a per-instance `getCommittees` read to price a position.
 *
 * `committeeNumId` 0 means the committee is not synced on this instance; `userAq`/`totalAq`/
 * `totalVotes` are then all 0. `committeeId` echoes the caller's input.
 */
export type FracAccountCommitteeAq = {
  /** Registry-assigned numeric ID of the instance */
  instanceNumId: Uint16
  /** On-chain app ID of the instance */
  instanceAppId: uint64
  /** Committee numeric ID as synced locally, or 0 if the committee is not synced */
  committeeNumId: Uint16
  /** 32-byte gGov committee ID (echoes the input) */
  committeeId: CommitteeId
  /** Human-readable instance label */
  instanceName: string
  /** The account's ingested AlgoQuarters in the committee, 0 if none */
  userAq: Uint32
  /** The committee's declared total AlgoQuarters, 0 if no ledger is open */
  totalAq: Uint32
  /** The instance's gGov voting power in the committee (the snapshot's `totalVotes`), 0 if unsynced */
  totalVotes: Uint32
}

/**
 * One account's internal vote record in one frac instance, tagged with the instance's identity.
 * Logged per instance by `FracDelegationRegistry.logAccountVotingRecords` so a caller can pull an
 * account's votes across all its instances for a given gGov period in one paged simulate, without a
 * follow-up lookup to learn which instance each record came from.
 *
 * The instance identity (`instanceNumId`, `instanceAppId`, `instanceName`) is supplied by the
 * registry from its own `instances` box; `topicVotes` is the account's `FracVotingRecord` fetched
 * from the instance. Empty `topicVotes` means the account has not voted in that period on that
 * instance (see `getEmptyFracVotingRecord`).
 */
export type FracAccountVotingRecord = {
  /** Registry-assigned numeric ID of the instance */
  instanceNumId: Uint16
  /** On-chain app ID of the instance */
  instanceAppId: uint64
  /** Human-readable instance label */
  instanceName: string
  /** Whether the record was cast by a delegatee on the voter's behalf */
  isDelegated: boolean
  /** [topic][option] internal votes, in AlgoQuarters; empty if the account has not voted */
  topicVotes: Uint32[][]
}

/**
 * ARC-28 event emitted by `FracDelegationInstance.vote`, mirroring `GGovVoteCast`.
 *
 * Encoded size is `81 + Σ(4 + 4·options)` bytes - the same fixed head as `GGovVoteCast`, whose
 * payload `GGovPeriod.setReady` already caps at 943, so this event always fits the 1024-byte log
 * limit for any period that is votable at all.
 */
export type FracVoteCast = {
  /** The account whose AlgoQuarters were voted */
  voter: Account
  /** The account that submitted the call - equals `voter` unless a delegatee cast it */
  sender: Account
  /** The voter's frac registry numeric account ID */
  accountId: Uint32
  /** The voter's AlgoQuarters weight in the period's committee */
  userAq: Uint32
  /** Whether this vote overwrote an earlier one */
  updateVote: boolean
  /** [topic][option] internal votes, in AlgoQuarters */
  topicVotes: Uint32[][]
}
