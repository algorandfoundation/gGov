import {
  abimethod,
  Account,
  Application,
  BoxMap,
  clone,
  Global,
  GlobalState,
  log,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { compileArc4, encodeArc4, StaticBytes, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { AccountIdContract } from '../base/account-id.algo'
import {
  errAccountIdMismatch,
  errAccountNumMismatch,
  errAlgoHoursExist,
  errAlgoHoursMismatch,
  errAlgoHoursNotExist,
  errAlgoHoursNotFinal,
  errCommitteeExists,
  errCommitteeNotExists,
  errEarly,
  errIncorrectVotes,
  errLate,
  errNoVotes,
  errNoVotingPower,
  errPeriodEndInvalid,
  errPeriodEndLessThanStart,
  errPeriodStartInvalid,
  errProposalCancelled,
  errProposalExists,
  errProposalNotExists,
  errState,
  errUnauthorized,
  errXGovProposalCommitteeMissing,
  errXGovProposalInvalidCreator,
  errXGovProposalStatusMissing,
  errXGovRegistryMissing,
} from '../base/errors.algo'
import {
  AccountAlgohourInput,
  AccountIdWithVotes,
  AlgohourAccountKey,
  AlgohourPeriodTotals,
  CommitteeId,
  DelegatorCommittee,
  DelegatorProposal,
  DelegatorVote,
  getEmptyDelegatorCommittee,
  getEmptyDelegatorProposal,
} from '../base/types.algo'
import { ensure, ensureExtra, u32 } from '../base/utils.algo'
import { GGovRegistryContract, ggovRegistryXGovKey } from '../ggov-registry/ggovRegistry.algo'
import {
  STATUS_SUBMITTED,
  STATUS_VOTING,
  xGovProposalCommitteeIdKey,
  XGovProposalMock,
  xGovProposalStatusKey,
  xGovProposalVoteOpenTsKey,
  xGovProposalVotingDurationKey,
} from '../xgov-proposal-mock/xGovProposalMock.algo'

const periodLength: uint64 = 1_000_000

export type AbsenteeMode = 'strict' | 'scaled'

type ProposalId = Application
type AccountId = Uint32
type VoteKey = [ProposalId, AccountId]

export class Delegator extends AccountIdContract {
  /** Committee Oracle Application ID */
  committeeOracleApp = GlobalState<Application>()
  /** Time in seconds before external vote end to submit votes */
  voteSubmitThreshold = GlobalState<uint64>({ initialValue: 3600 * 3 })
  /** Absentee mode: strict or scaled */
  absenteeMode = GlobalState<string>({ initialValue: 'strict' })
  /** Synced committee details w/ own delegated totals */
  committees = BoxMap<CommitteeId, DelegatorCommittee>({ keyPrefix: 'C' })
  /** Proposal metadata */
  proposals = BoxMap<Application, DelegatorProposal>({ keyPrefix: 'P' })
  /** Total algohours for each period */
  algohourPeriodTotals = BoxMap<uint64, AlgohourPeriodTotals>({ keyPrefix: 'H' })
  /** Algohours for each account for each period */
  algohourAccounts = BoxMap<AlgohourAccountKey, uint64>({ keyPrefix: 'h' })
  /** Voting records */
  votes = BoxMap<VoteKey, DelegatorVote>({ keyPrefix: 'V' })

  /**
   * Set the Committee Oracle Application ID
   * @param appId Application ID of Committee Oracle
   */
  public setCommitteeOracleApp(appId: Application): void {
    this.ensureCallerIsAdmin()
    this.committeeOracleApp.value = appId
  }

  /**
   * Set the vote submit threshold (time in seconds before external vote end)
   * @param threshold Time in seconds
   */
  public setVoteSubmitThreshold(threshold: uint64): void {
    this.ensureCallerIsAdmin()
    this.voteSubmitThreshold.value = threshold
  }

  /**
   * Set the absentee mode
   * @param mode 'strict' or 'scaled'
   */
  public setAbsenteeMode(mode: AbsenteeMode): void {
    this.ensureCallerIsAdmin()
    this.absenteeMode.value = mode
  }

  /**
   * Sync committee metadata and delegated accounts from the GGov registry
   * @param committeeId Committee ID to sync
   * @param delegatedAccounts Accounts delegated to this contract
   */
  public syncCommitteeMetadata(committeeId: CommitteeId, delegatedAccounts: Account[]) {
    this.ensureCallerIsAdmin()
    const committeeBox = this.committees(committeeId)
    ensure(!committeeBox.exists, errCommitteeExists)

    const oracleApp = compileArc4(GGovRegistryContract)
    const remoteCommittee = oracleApp.call.getCommitteeMetadata({
      appId: this.committeeOracleApp.value,
      args: [committeeId, true],
    }).returnValue

    const committee: DelegatorCommittee = {
      periodStart: remoteCommittee.periodStart,
      periodEnd: remoteCommittee.periodEnd,
      extDelegatedVotes: u32(0),
      extDelegatedAccountVotes: [] as AccountIdWithVotes[],
    }

    let extDelegatedVotes: uint64 = 0
    for (const account of delegatedAccounts) {
      const localAccountId = this.getOrCreateAccountId(account)
      const remoteVotes = oracleApp.call.getGovVotingPower({
        appId: this.committeeOracleApp.value,
        args: [committeeId, account],
      }).returnValue
      ensureExtra(remoteVotes.asUint64() > 0, errNoVotingPower, account.bytes)
      // TODO verify that this account has delegated to our escrow on xGov registry
      extDelegatedVotes += remoteVotes.asUint64()
      committee.extDelegatedAccountVotes.push({ accountId: localAccountId, votes: remoteVotes })
    }
    committee.extDelegatedVotes = u32(extDelegatedVotes)
    committeeBox.value = clone(committee)

    return committee
  }

  public syncProposalMetadata(proposalId: Application): DelegatorProposal {
    // initial sync only. Updates to use separate resync method
    const proposalBox = this.proposals(proposalId)
    ensure(!proposalBox.exists, errProposalExists)

    // get xgov registry app id from oracle
    // validate proposal was created by xgov registry
    const [registryAppId, registryAppExists] = op.AppGlobal.getExUint64(
      this.committeeOracleApp.value,
      ggovRegistryXGovKey,
    )
    ensure(registryAppExists, errXGovRegistryMissing)
    const proposalCreator = proposalId.creator
    const registryEscrow = Application(registryAppId).address
    ensure(proposalCreator === registryEscrow, errXGovProposalInvalidCreator)

    // get committee ID from proposal contract
    // ensure committee metadata is synced
    const [_committeeId, committeeIdExists] = op.AppGlobal.getExBytes(proposalId, xGovProposalCommitteeIdKey)
    ensure(committeeIdExists, errXGovProposalCommitteeMissing)
    const committeeId = new StaticBytes<32>(_committeeId)
    const committeeBox = this.committees(committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    const committeeMetadata = committeeBox.value as Readonly<DelegatorCommittee>

    let totalAlgoHours: uint64 = 0
    // ensure all periods are final
    // TODO should this be in committee sync instead?
    for (
      let period: uint64 = committeeMetadata.periodStart.asUint64();
      period < committeeMetadata.periodEnd.asUint64();
      period += periodLength
    ) {
      const periodTotalsBox = this.algohourPeriodTotals(period)
      ensureExtra(periodTotalsBox.exists, errAlgoHoursNotExist, op.itob(period))
      ensureExtra(periodTotalsBox.value.final, errAlgoHoursNotFinal, op.itob(period))

      totalAlgoHours += periodTotalsBox.value.totalAlgohours
    }

    // get status and vote end ts
    const [status, statusExists] = op.AppGlobal.getExUint64(proposalId, xGovProposalStatusKey)
    const [voteOpenTs, _voteOpenTsExists] = op.AppGlobal.getExUint64(proposalId, xGovProposalVoteOpenTsKey)
    const [votingDuration, _votingDurationExists] = op.AppGlobal.getExUint64(proposalId, xGovProposalVotingDurationKey)
    ensure(statusExists, errXGovProposalStatusMissing)
    // ensure(voteOpenTsExists, errXGovProposalVoteOpenTsMissing)
    // ensure(votingDurationExists, errXGovProposalVotingDurationMissing)

    ensure(status === STATUS_VOTING || (status === STATUS_SUBMITTED && voteOpenTs <= Global.latestTimestamp), errState)
    const voteEndTs: uint64 = voteOpenTs + votingDuration

    const proposalMetadata: DelegatorProposal = {
      status: 'WAIT',
      committeeId: committeeId,
      extVoteStartTime: u32(voteOpenTs),
      extVoteEndTime: u32(voteEndTs),
      extTotalVotingPower: committeeMetadata.extDelegatedVotes,
      extAccountsPendingVotes: clone(committeeMetadata.extDelegatedAccountVotes),
      extAccountsVoted: [] as AccountIdWithVotes[],
      intVoteEndTime: u32(voteEndTs - this.voteSubmitThreshold.value), // set internal vote end time earlier than external to allow for vote submission before xGov proposal voting ends
      intTotalAlgohours: totalAlgoHours,
      intVotedAlgohours: 0,
      intVotesYesAlgohours: 0,
      intVotesNoAlgohours: 0,
      intVotesAbstainAlgohours: 0,
      intVotesBoycottAlgohours: 0,
    }
    proposalBox.value = clone(proposalMetadata)
    return proposalMetadata
  }

  /**
   * Cast internal vote for proposal. This will update the proposal metadata and voting records, but will NOT submit votes to the xGov proposal contract.
   * @param proposalId xGov proposal Application ID
   * @param voterAccount Account of the voter. Must be the same as Txn.sender for now
   * @param vote Voting record for this vote, including yes, no, abstain, and boycott votes. The contract will verify that the total votes matches the voting power of the account.
   */
  public voteInternal(proposalId: Application, voterAccount: Account, vote: DelegatorVote): void {
    // perhaps internal delegation later, for now only allow voting from the account that earned the algohours
    ensure(Txn.sender === voterAccount, errUnauthorized)

    const proposalBox = this.proposals(proposalId)
    ensure(proposalBox.exists, errProposalNotExists)
    const proposal = clone(proposalBox.value)
    ensure(proposal.status !== 'CANC', errProposalCancelled)

    const committeeBox = this.committees(proposal.committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    const committee = committeeBox.value as Readonly<DelegatorCommittee>

    ensure(proposal.extVoteStartTime.asUint64() <= Global.latestTimestamp, errEarly)
    ensure(Global.latestTimestamp < proposal.intVoteEndTime.asUint64(), errLate)

    const votingPower = this.getAggregatedAccountAlgoHours(
      committee.periodStart.asUint64(),
      committee.periodEnd.asUint64(),
      voterAccount,
    )
    ensure(votingPower > 0, errNoVotingPower)
    const totalVotesCast: uint64 = vote.yesVotes + vote.noVotes + vote.boycottVotes + vote.abstainVotes
    ensure(totalVotesCast === votingPower, errIncorrectVotes)

    const voterAccountId = this.mustGetAccountId(voterAccount)
    const voteBoxKey: VoteKey = [proposalId, voterAccountId]
    const voteBox = this.votes(voteBoxKey)

    if (voteBox.exists) {
      // updating existing vote
      const previousVote = voteBox.value as Readonly<DelegatorVote>
      // first remove existing vote from proposal totals
      proposal.intVotedAlgohours -= totalVotesCast
      proposal.intVotesYesAlgohours -= previousVote.yesVotes
      proposal.intVotesNoAlgohours -= previousVote.noVotes
      proposal.intVotesBoycottAlgohours -= previousVote.boycottVotes
      proposal.intVotesAbstainAlgohours -= previousVote.abstainVotes
    }

    if (proposal.status !== 'VOTE') {
      proposal.status = 'VOTE'
    }
    proposal.intVotedAlgohours += totalVotesCast
    proposal.intVotesYesAlgohours += vote.yesVotes
    proposal.intVotesNoAlgohours += vote.noVotes
    proposal.intVotesBoycottAlgohours += vote.boycottVotes
    proposal.intVotesAbstainAlgohours += vote.abstainVotes
    voteBox.value = clone(vote)
    proposalBox.value = clone(proposal)

    // TODO emit event
  }

  // TODO resyncProposalMetadata
  // update status, detect cancelled proposals
  // update delegated accounts having voted

  /**
   * Submit a vote to the xGov proposal contract for each external account, with approvals and rejections calculated based on the internal vote and absentee mode
   * @param proposalId xGov proposal Application ID
   * @param extAccounts external accounts to submit votes for. MUST match the ext. accounts pending votes in proposal metadata in the same ORDER.
   */
  public voteExternal(proposalId: Application, extAccounts: Account[]): void {
    const proposalBox = this.proposals(proposalId)
    ensure(proposalBox.exists, errProposalNotExists)
    const proposal = clone(proposalBox.value)
    // TODO resync
    ensure(proposal.status === 'VOTE', errState)

    ensure(proposal.extVoteStartTime.asUint64() <= Global.latestTimestamp, errEarly)
    ensure(Global.latestTimestamp < proposal.extVoteEndTime.asUint64(), errLate)
    ensure(proposal.intVotedAlgohours > 0, errNoVotes)
    ensure(extAccounts.length === proposal.extAccountsPendingVotes.length, errAccountNumMismatch)

    let totalApprovals: uint64 = 0
    let totalRejections: uint64 = 0
    const isBoycott = proposal.intVotesBoycottAlgohours * 2 >= proposal.intTotalAlgohours
    if (!isBoycott) {
      const denominator = this.absenteeMode.value === 'scaled' ? proposal.intVotedAlgohours : proposal.intTotalAlgohours
      totalApprovals = (proposal.intVotesYesAlgohours * proposal.extTotalVotingPower.asUint64()) / denominator
      totalRejections = (proposal.intVotesNoAlgohours * proposal.extTotalVotingPower.asUint64()) / denominator
    }

    // TODO emit total votes event

    for (let i: uint64 = 0; i < extAccounts.length; i++) {
      const extAccount = extAccounts[i]
      const extAccountId = this.accountIds(extAccount).value
      const extAccountsPendingVote = clone(proposal.extAccountsPendingVotes[i])
      ensureExtra(extAccountId === extAccountsPendingVote.accountId, errAccountIdMismatch, op.itob(i))

      let approvals: uint64
      let rejections: uint64
      if (isBoycott) {
        approvals = extAccountsPendingVote.votes.asUint64()
        rejections = extAccountsPendingVote.votes.asUint64()
      } else {
        // round down issues are intentionally ignored here
        approvals = (totalApprovals * extAccountsPendingVote.votes.asUint64()) / proposal.extTotalVotingPower.asUint64()
        rejections =
          (totalRejections * extAccountsPendingVote.votes.asUint64()) / proposal.extTotalVotingPower.asUint64()
      }
      // TODO emit individual vote event
      compileArc4(XGovProposalMock).call.vote({
        appId: proposalId,
        args: [extAccount, approvals, rejections],
      })
      proposal.extAccountsVoted.push(extAccountsPendingVote)
    }
    proposal.extAccountsPendingVotes = []
    proposal.status = 'VOTD'
    proposalBox.value = clone(proposal)
  }

  /**
   * Add account algohours and update total algohours for period
   * @param periodStart period start. Aligned to 1M
   * @param accountAlgohourInputs
   */
  public addAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: AccountAlgohourInput[]): void {
    this.ensureCallerIsAdmin()
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)

    for (const { account, hours } of clone(accountAlgohourInputs)) {
      const accountId = this.getOrCreateAccountId(account)
      const key: AlgohourAccountKey = [periodStart, accountId]
      const box = this.algohourAccounts(key)
      ensureExtra(!box.exists, errAlgoHoursExist, account.bytes)
      box.value = hours

      const totalBox = this.algohourPeriodTotals(periodStart)
      if (totalBox.exists) {
        totalBox.value.totalAlgohours += hours
      } else {
        totalBox.value = { totalAlgohours: hours, final: false }
      }
    }
  }

  /**
   * Remove account algohours and update total algohours for period
   * @param periodStart period start. Aligned to 1M
   * @param accountAlgohourInputs
   */
  public removeAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: AccountAlgohourInput[]): void {
    this.ensureCallerIsAdmin()
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)

    for (const { account, hours } of clone(accountAlgohourInputs)) {
      const accountId = this.mustGetAccountId(account)
      const key: AlgohourAccountKey = [periodStart, accountId]
      const box = this.algohourAccounts(key)
      ensureExtra(box.exists, errAlgoHoursNotExist, account.bytes)
      ensureExtra(box.value === hours, errAlgoHoursMismatch, account.bytes) // ensure hours to remove matches existing hours to prevent accidental double removal
      box.delete()

      const totalBox = this.algohourPeriodTotals(periodStart)
      ensure(totalBox.exists, errAlgoHoursNotExist)
      totalBox.value.totalAlgohours -= hours
    }
  }

  /**
   * Update period algohour finality - indicates account algohour records are complete for this period
   * @param periodStart period start
   * @returns total algohours for period
   */
  public updateAlgoHourPeriodFinality(periodStart: uint64, totalAlgohours: uint64, final: boolean): void {
    this.ensureCallerIsAdmin()
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)
    const box = this.algohourPeriodTotals(periodStart)
    ensure(box.exists, errAlgoHoursNotExist)
    ensure(box.value.totalAlgohours === totalAlgohours, errAlgoHoursMismatch)
    box.value.final = final
  }

  /*
   * Getters
   */

  /**
   * Sum account algohours over multiple 1M periods
   * @param periodStart period start, inclusive. Aligned to 1M
   * @param periodEnd period end, exclusive. Aligned to 1M
   * @param account account
   * @returns total algohours
   */
  private getAggregatedAccountAlgoHours(periodStart: uint64, periodEnd: uint64, account: Account): uint64 {
    ensure(periodEnd > periodStart, errPeriodEndLessThanStart)
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)
    ensure(periodEnd % periodLength === 0, errPeriodEndInvalid)
    const accountId = this.getAccountIdIfExists(account)
    if (accountId.asUint64() === 0) {
      return 0
    }
    let algohours: uint64 = 0
    for (let period = periodStart; period < periodEnd; period += periodLength) {
      const key: AlgohourAccountKey = [period, accountId]
      const box = this.algohourAccounts(key)
      algohours += box.exists ? box.value : 0
    }
    return algohours
  }

  /**
   * Get total algohours for period
   * @param periodStart period start
   * @returns total algohours for period
   */
  @abimethod({ readonly: true })
  public getAlgoHourPeriodTotals(periodStart: uint64): AlgohourPeriodTotals {
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)
    const box = this.algohourPeriodTotals(periodStart)
    return box.exists ? box.value : { totalAlgohours: 0, final: false }
  }

  /**
   * Get account algohours for period
   * @param periodStart period start
   * @param account
   * @returns
   */
  @abimethod({ readonly: true })
  public getAccountAlgoHours(periodStart: uint64, account: Account): uint64 {
    ensure(periodStart % periodLength === 0, errPeriodStartInvalid)
    const accountId = this.getAccountIdIfExists(account)
    if (accountId.asUint64() === 0) {
      return 0
    }
    const key: AlgohourAccountKey = [periodStart, accountId]
    const box = this.algohourAccounts(key)
    return box.exists ? box.value : 0
  }

  /**
   * Log committee metadata for multiple committees
   * @param committeeIds Committee IDs to log
   */
  @abimethod({ readonly: true })
  public logCommitteeMetadata(committeeIds: CommitteeId[]): void {
    for (const committeeId of committeeIds) {
      const metadata = this.committees(committeeId)
      if (metadata.exists) {
        log(encodeArc4(metadata.value))
      } else {
        log(encodeArc4(getEmptyDelegatorCommittee()))
      }
    }
  }

  /**
   * Log proposal metadata for multiple proposals
   * @param proposalIds Proposal Application IDs to log
   */
  @abimethod({ readonly: true })
  public logProposalMetadata(proposalIds: Application[]): void {
    for (const proposalId of proposalIds) {
      const metadata = this.proposals(proposalId)
      if (metadata.exists) {
        log(encodeArc4(metadata.value))
      } else {
        log(encodeArc4(getEmptyDelegatorProposal()))
      }
    }
  }
}
