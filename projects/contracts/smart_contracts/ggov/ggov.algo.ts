import {
  Account,
  BoxMap,
  bytes,
  Bytes,
  clone,
  contract,
  err,
  Global,
  GlobalState,
  log,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { abimethod, compileArc4, encodeArc4, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import {
  errGGovCannotOverride,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovPeriodNotExists,
  errGGovSelfDelegate,
  errGGovTopicIndexOOB,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingActive,
  errGGovVotingEnded,
  errGGovVotingNotStarted,
  errNotOperator,
  errPeriodEndLessThanStart,
} from '../base/errors.algo'
import {
  CommitteeId,
  getEmptyGGovPeriod,
  getEmptyGGovVoteRecord,
  GGovPeriod,
  GGovTopic,
  GGovTopicBigKey,
  GGovVoteKey,
  GGovVoteRecord,
} from '../base/types.algo'
import { ensure, u32 } from '../base/utils.algo'
import { CommitteeOracleContract } from '../oracle/oracle.algo'
import { XGovRegistryMock } from '../xgov-registry-mock/xGovRegistryMock.algo'

@contract({ name: 'GGov' })
export class GGovContract extends CommitteeOracleContract {
  /** Auto-increment period IDs */
  lastPeriodId = GlobalState<uint64>({ initialValue: 0 })
  /** Operator address for CRUD operations */
  operator = GlobalState<Account>()

  /** Period metadata with inlined topics and vote tallies */
  periods = BoxMap<Uint32, GGovPeriod>({ keyPrefix: 'p' })
  /** Raw JSON period body (chunked upload) */
  periodsBig = BoxMap<Uint32, bytes>({ keyPrefix: 'P' })
  /** Raw JSON topic body, keyed by [periodId, topicIndex] */
  topicsBig = BoxMap<GGovTopicBigKey, bytes>({ keyPrefix: 'T' })
  /** Per-account per-period voting record */
  voteRecords = BoxMap<GGovVoteKey, GGovVoteRecord>({ keyPrefix: 'v' })
  /** Delegator -> delegatee mapping */
  delegations = BoxMap<Account, Account>({ keyPrefix: 'd' })

  // ── Helpers ──────────────────────────────────────────────────────

  protected ensureCallerIsOperator(): void {
    ensure(Txn.sender === this.operator.value, errNotOperator)
  }

  // ── Admin methods ────────────────────────────────────────────────

  /**
   * Set the operator address
   * @param account Operator account
   */
  public setOperator(account: Account): void {
    this.ensureCallerIsAdmin()
    this.operator.value = account
  }

  // ── Operator: Period CRUD ────────────────────────────────────────

  /**
   * Add a new voting period
   * @param committeeId Committee ID (must be complete)
   * @param votingStart Unix timestamp for voting start
   * @param votingEnd Unix timestamp for voting end
   * @returns New period ID
   */
  public addPeriod(committeeId: CommitteeId, votingStart: uint64, votingEnd: uint64): uint64 {
    this.ensureCallerIsOperator()
    ensure(votingEnd > votingStart, errPeriodEndLessThanStart)

    // Verify committee exists and is complete (local call, inherited)
    this.getCommitteeMetadata(committeeId, true)

    this.lastPeriodId.value++
    const periodId = u32(this.lastPeriodId.value)

    this.periods(periodId).value = {
      committeeId: committeeId,
      votingStart: u32(votingStart),
      votingEnd: u32(votingEnd),
      topics: [] as GGovTopic[],
    }

    return this.lastPeriodId.value
  }

  /**
   * Edit voting period (only before voting starts)
   * @param periodId Period ID
   * @param committeeId Committee ID (must be complete)
   * @param votingStart New voting start
   * @param votingEnd New voting end
   */
  public editPeriod(periodId: uint64, committeeId: CommitteeId, votingStart: uint64, votingEnd: uint64): void {
    this.ensureCallerIsOperator()
    ensure(votingEnd > votingStart, errPeriodEndLessThanStart)

    // Verify committee exists and is complete (local call, inherited)
    this.getCommitteeMetadata(committeeId, true)

    const periodBox = this.periods(u32(periodId))
    ensure(periodBox.exists, errGGovPeriodNotExists)
    const period = clone(periodBox.value)

    // Cannot edit if voting has started
    ensure(Global.latestTimestamp < period.votingStart.asUint64(), errGGovVotingActive)

    period.committeeId = committeeId
    period.votingStart = u32(votingStart)
    period.votingEnd = u32(votingEnd)
    periodBox.value = clone(period)
  }

  /**
   * Chunked upload of period body JSON
   * @param periodId Period ID
   * @param startOffset Byte offset to write at
   * @param data Data chunk
   * @param last Whether this is the last chunk
   */
  public uploadPeriodBodyPartial(periodId: uint64, startOffset: uint64, data: bytes, last: boolean): void {
    this.ensureCallerIsOperator()
    ensure(this.periods(u32(periodId)).exists, errGGovPeriodNotExists)

    const boxKey = Bytes`P`.concat(encodeArc4(u32(periodId)))
    const writeEnd: uint64 = startOffset + data.length
    if (startOffset === 0) {
      op.Box.delete(boxKey)
      op.Box.create(boxKey, writeEnd)
    } else {
      const [boxLen] = op.Box.length(boxKey)
      if (writeEnd > boxLen) {
        op.Box.resize(boxKey, writeEnd)
      }
    }
    op.Box.replace(boxKey, startOffset, data)
  }

  // ── Operator: Topic CRUD ─────────────────────────────────────────

  /**
   * Add a topic to a period (appends to topics array)
   * @param periodId Period ID
   * @param options Option labels
   * @returns Topic index (0-based)
   */
  public addTopic(periodId: uint64, options: string[]): uint64 {
    this.ensureCallerIsOperator()
    ensure(options.length > 0, errGGovNoOptions)

    const periodBox = this.periods(u32(periodId))
    ensure(periodBox.exists, errGGovPeriodNotExists)
    const period = clone(periodBox.value)

    // Cannot add topics if voting has started
    ensure(Global.latestTimestamp < period.votingStart.asUint64(), errGGovVotingActive)

    // Create zeroed votes array matching options length
    const votes: Uint32[] = []
    for (let i: uint64 = 0; i < options.length; i++) {
      votes.push(u32(0))
    }

    const topic: GGovTopic = {
      options: clone(options),
      votes: clone(votes),
    }
    const topicIndex: uint64 = period.topics.length
    period.topics.push(clone(topic))
    periodBox.value = clone(period)

    return topicIndex
  }

  /**
   * Edit a topic's options (only if no votes cast yet)
   * @param periodId Period ID
   * @param topicIndex Topic index
   * @param options New option labels
   */
  public editTopic(periodId: uint64, topicIndex: uint64, options: string[]): void {
    this.ensureCallerIsOperator()
    ensure(options.length > 0, errGGovNoOptions)

    const periodBox = this.periods(u32(periodId))
    ensure(periodBox.exists, errGGovPeriodNotExists)
    const period = clone(periodBox.value)

    ensure(topicIndex < period.topics.length, errGGovTopicIndexOOB)

    // Cannot edit topics if voting has started
    ensure(Global.latestTimestamp < period.votingStart.asUint64(), errGGovVotingActive)

    // Replace topic with new options and zeroed votes
    const votes: Uint32[] = []
    for (let i: uint64 = 0; i < options.length; i++) {
      votes.push(u32(0))
    }
    period.topics[topicIndex] = {
      options: clone(options),
      votes: clone(votes),
    }
    periodBox.value = clone(period)
  }

  /**
   * Chunked upload of topic body JSON
   * @param periodId Period ID
   * @param topicIndex Topic index
   * @param startOffset Byte offset to write at
   * @param data Data chunk
   * @param last Whether this is the last chunk
   */
  public uploadTopicBodyPartial(
    periodId: uint64,
    topicIndex: uint64,
    startOffset: uint64,
    data: bytes,
    last: boolean,
  ): void {
    this.ensureCallerIsOperator()
    ensure(this.periods(u32(periodId)).exists, errGGovPeriodNotExists)

    const boxKey = Bytes`T`.concat(encodeArc4(u32(periodId))).concat(encodeArc4(u32(topicIndex)))
    const writeEnd: uint64 = startOffset + data.length
    if (startOffset === 0) {
      op.Box.delete(boxKey)
      op.Box.create(boxKey, writeEnd)
    } else {
      const [boxLen] = op.Box.length(boxKey)
      if (writeEnd > boxLen) {
        op.Box.resize(boxKey, writeEnd)
      }
    }
    op.Box.replace(boxKey, startOffset, data)
  }

  // ── Delegation ───────────────────────────────────────────────────

  /**
   * Delegate voting power to another account
   * @param delegatee Account to delegate to
   */
  public delegate(delegatee: Account): void {
    ensure(Txn.sender !== delegatee, errGGovSelfDelegate)
    this.delegations(Txn.sender).value = delegatee
  }

  /**
   * Remove delegation
   */
  public undelegate(): void {
    const box = this.delegations(Txn.sender)
    ensure(box.exists, errGGovNoDelegation)
    box.delete()
  }

  /**
   * Mirror delegation from xGov registry
   * @param account Account to mirror delegation for
   */
  public mirrorXGovDelegation(account: Account): void {
    const registry = compileArc4(XGovRegistryMock)
    const [xGovBox, exists] = registry.call.getXGovBox({
      appId: this.xGovRegistryApp.value,
      args: [account],
    }).returnValue

    if (exists && xGovBox.votingAddress !== Global.zeroAddress) {
      this.delegations(account).value = xGovBox.votingAddress
    }
  }

  // ── Voting ───────────────────────────────────────────────────────

  /**
   * Cast votes on all topics in a period
   * @param periodId Period ID
   * @param voterAccount Account voting (may differ from sender if delegated)
   * @param topicVotes 2D array: outer = per topic, inner = per option. Each topic's votes must sum to voting power.
   */
  public vote(periodId: uint64, voterAccount: Account, topicVotes: uint64[][]): void {
    const periodBox = this.periods(u32(periodId))
    ensure(periodBox.exists, errGGovPeriodNotExists)
    const period = clone(periodBox.value)

    // Validate voting window
    ensure(Global.latestTimestamp >= period.votingStart.asUint64(), errGGovVotingNotStarted)
    ensure(Global.latestTimestamp < period.votingEnd.asUint64(), errGGovVotingEnded)

    // Check delegation if sender != voter
    let isDelegated = false
    if (Txn.sender !== voterAccount) {
      const delegationBox = this.delegations(voterAccount)
      ensure(delegationBox.exists, errGGovNoDelegation)
      ensure(delegationBox.value === Txn.sender, errGGovNoDelegation)
      isDelegated = true
    }

    // Voter must already be a known oracle account (ingested committee member)
    const oracleAccount = this.mustGetAccount(voterAccount)

    // Get voting power from inherited oracle
    const votingPower = this.getXGovVotingPower(period.committeeId, voterAccount)

    // Validate topicVotes dimensions
    ensure(topicVotes.length === period.topics.length, errGGovVoteMismatch)

    // Validate each topic's vote allocation
    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      ensure(topicVote.length === period.topics[i].options.length, errGGovVoteMismatch)
      let voteSum: uint64 = 0
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        voteSum += topicVote[j]
      }
      ensure(voteSum === votingPower.asUint64(), errGGovVotePowerMismatch)
    }
    const voteKey: GGovVoteKey = [u32(periodId), oracleAccount.accountId]
    const voteRecordBox = this.voteRecords(voteKey)

    // Handle existing vote record
    if (voteRecordBox.exists) {
      const existingRecord = clone(voteRecordBox.value)
      // Delegatee cannot override a direct vote
      if (isDelegated && !existingRecord.byDelegator) {
        log(errGGovCannotOverride)
        err()
      }
      // Subtract old votes — build new votes per topic, assign once
      // (avoids per-option dynamic_array_replace: O(T) assigns instead of O(T×O))
      for (let i: uint64 = 0; i < existingRecord.topicVotes.length; i++) {
        const oldTopicVotes = clone(existingRecord.topicVotes[i])
        const currentVotes = clone(period.topics[i].votes)
        const subtractedVotes: Uint32[] = []
        for (let j: uint64 = 0; j < oldTopicVotes.length; j++) {
          subtractedVotes.push(u32(currentVotes[j].asUint64() - oldTopicVotes[j].asUint64()))
        }
        period.topics[i] = { options: clone(period.topics[i].options), votes: clone(subtractedVotes) }
      }
    }

    // Add new votes — build new votes per topic, assign once
    const newTopicVotes: Uint32[][] = []
    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      const currentVotes = clone(period.topics[i].votes)
      const newVotes: Uint32[] = []
      const recordRow: Uint32[] = []
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        newVotes.push(u32(currentVotes[j].asUint64() + topicVote[j]))
        recordRow.push(u32(topicVote[j]))
      }
      period.topics[i] = { options: clone(period.topics[i].options), votes: clone(newVotes) }
      newTopicVotes.push(clone(recordRow))
    }

    // Save updated period with new tallies
    periodBox.value = clone(period)

    // Save vote record
    const newRecord: GGovVoteRecord = {
      byDelegator: isDelegated,
      topicVotes: clone(newTopicVotes),
    }
    voteRecordBox.value = clone(newRecord)
  }

  /**
   * Check if an account can vote in a period
   * @param periodId Period ID
   * @param voterAccount Account with voting power
   * @param senderAccount Account that will attempt to vote
   */
  @abimethod({ readonly: true })
  public canVote(periodId: uint64, voterAccount: Account, senderAccount: Account): [boolean, uint64] {
    const periodBox = this.periods(u32(periodId))
    if (!periodBox.exists) return [false, 0]

    const period = clone(periodBox.value)
    if (Global.latestTimestamp < period.votingStart.asUint64()) return [false, 0]
    if (Global.latestTimestamp >= period.votingEnd.asUint64()) return [false, 0]

    // Check delegation if sender != voter
    if (senderAccount !== voterAccount) {
      const delegationBox = this.delegations(voterAccount)
      if (!delegationBox.exists) return [false, 0]
      if (delegationBox.value !== senderAccount) return [false, 0]
    }

    const oracleAccount = this.getAccountIfExists(voterAccount)
    if (oracleAccount.accountId.asUint64() === 0) return [false, 0]

    const votingPower = this.getXGovVotingPower(period.committeeId, voterAccount)
    return [true, votingPower.asUint64()]
  }

  // ── Read methods ─────────────────────────────────────────────────

  /**
   * Get period metadata with inlined topics and vote tallies
   * @param periodId Period ID
   * @returns GGovPeriod
   */
  @abimethod({ readonly: true })
  public getPeriod(periodId: uint64): GGovPeriod {
    const periodBox = this.periods(u32(periodId))
    if (periodBox.exists) return periodBox.value
    return getEmptyGGovPeriod()
  }

  /**
   * Get voting record for an account in a period
   * @param periodId Period ID
   * @param account Account
   * @returns GGovVoteRecord
   */
  @abimethod({ readonly: true })
  public getVotingRecord(periodId: uint64, account: Account): GGovVoteRecord {
    const oracleAccount = this.getAccountIfExists(account)
    if (oracleAccount.accountId.asUint64() === 0) return getEmptyGGovVoteRecord()
    const voteKey: GGovVoteKey = [u32(periodId), oracleAccount.accountId]
    const box = this.voteRecords(voteKey)
    if (box.exists) return box.value
    return getEmptyGGovVoteRecord()
  }

  /**
   * Get delegation for an account
   * @param account Account
   * @returns [delegatee, exists]
   */
  @abimethod({ readonly: true })
  public getDelegation(account: Account): [Account, boolean] {
    const box = this.delegations(account)
    if (box.exists) return [box.value, true]
    return [Global.zeroAddress, false]
  }

  /**
   * Batch log delegations for off-chain retrieval
   * @param accounts Accounts to log delegations for
   * Logs delegatee address or zero address if no delegation, in the same order as input accounts
   */
  @abimethod({ readonly: true })
  public logDelegations(accounts: Account[]): void {
    for (const account of accounts) {
      const box = this.delegations(account)
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(Global.zeroAddress))
      }
    }
  }

  /**
   * Batch log period metadata for off-chain retrieval
   * @param periodIds Period IDs to log
   */
  @abimethod({ readonly: true })
  public logPeriods(periodIds: uint64[]): void {
    for (const periodId of periodIds) {
      const periodBox = this.periods(u32(periodId))
      if (periodBox.exists) {
        log(encodeArc4(periodBox.value))
      } else {
        log(encodeArc4(getEmptyGGovPeriod()))
      }
    }
  }
}
