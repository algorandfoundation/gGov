import { Account, uint64 } from '@algorandfoundation/algorand-typescript'
import { StaticBytes, Uint16, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
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
 * Input representation of a committee xGov
 */
export type AccountWithVotes = {
  account: Account
  votes: Uint32
}

/**
 * Stored representation of a committee xGov
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

/** Topic - inlined in GGovPeriod */
export type GGovTopic = {
  options: string[]
  votes: Uint32[]
}

/** Period - stored in BoxMap<Uint32, GGovPeriod> */
export type GGovPeriod = {
  committeeId: CommitteeId
  votingStart: Uint32
  votingEnd: Uint32
  topics: GGovTopic[]
}

/** Vote record per account per period */
export type GGovVoteRecord = {
  byDelegator: boolean
  topicVotes: Uint32[][]
}

export function getEmptyGGovPeriod(): GGovPeriod {
  return {
    committeeId: new StaticBytes<32>(),
    votingStart: u32(0),
    votingEnd: u32(0),
    topics: [] as GGovTopic[],
  }
}

export function getEmptyGGovVoteRecord(): GGovVoteRecord {
  return {
    byDelegator: false,
    topicVotes: [] as Uint32[][],
  }
}
