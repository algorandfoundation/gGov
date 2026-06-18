import {
  Account,
  Application,
  baremethod,
  Box,
  BoxMap,
  bytes,
  Bytes,
  clone,
  contract,
  emit,
  err,
  Global,
  GlobalState,
  itxn,
  log,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { abimethod, compileArc4, encodeArc4, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import {
  errAlreadyInit,
  errGGovCannotOverride,
  errGGovDelegationNoAcctRef,
  errGGovHasVotes,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
  errGGovUnvotable,
  errGGovTopicIndexOOB,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingEnded,
  errGGovVotingNotStarted,
  errNotOperator,
  errPeriodEndLessThanStart,
  errUnauthorized,
} from '../base/errors.algo'
import {
  CommitteeId,
  getEmptyGGovPeriod,
  getEmptyGGovVoteRecord,
  GGovPeriod,
  GGovPeriodMeta,
  GGovTopic,
  GGovTopicOptions,
  GGovTopicVotes,
  GGovVoteCast,
  GGovVoteRecord,
  GGovVoteRecordMeta,
} from '../base/types.algo'
import { ensure, u32 } from '../base/utils.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'

@contract({ name: 'GGovPeriod' })
export class GGovPeriodContract extends BaseContract {
  /** Registry app ID. 0 sentinel = uninitialised */
  registryApp = GlobalState<uint64>({ initialValue: 0 })
  /** This period's ID on the registry */
  periodId = GlobalState<uint64>()
  /** Voting window start (unix seconds) */
  votingStart = GlobalState<uint64>()
  /** Voting window end exclusive (unix seconds) */
  votingEnd = GlobalState<uint64>()
  /** Operator-set ready flag. Period must be ready=true to accept votes; cannot be edited while ready. */
  ready = GlobalState<boolean>({ initialValue: false })
  /** Committee ID this period votes against (lives in registry) */
  committeeId = GlobalState<CommitteeId>()
  /** First actual voting round. Used for efficient indexer lookups. 0 until the first vote is cast. */
  firstVotingRound = GlobalState<uint64>({ initialValue: 0 })
  /** Last actual voting round. Used for efficient indexer lookups. 0 until the first vote is cast. */
  lastVotingRound = GlobalState<uint64>({ initialValue: 0 })

  /** Per-topic option labels. Mutated only while editable. Parallel to topicVotesArr (same length & order). */
  topicOptionsArr = Box<GGovTopicOptions[]>({ key: 'o' })
  /** Per-topic vote tallies. Mutated on every vote(). Parallel to topicOptionsArr (same length & order). */
  topicVotesArr = Box<GGovTopicVotes[]>({ key: 't' })
  /** Period body JSON (chunked) */
  periodBody = Box<bytes>({ key: 'P' })
  /** Topic body JSON by topicIndex */
  topicBodies = BoxMap<uint64, bytes>({ keyPrefix: 'T' })
  /** Per-voter vote record, keyed by voter Account */
  voteRecords = BoxMap<Account, GGovVoteRecord>({ keyPrefix: 'v' })

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Initialise the period. Called as an inner ARC-4 call from the registry's createPeriod.
   * Can only be called once (registryApp must still be 0); creator (the registry app account)
   * is the only allowed sender.
   */
  @abimethod()
  public init(
    registryApp: Application,
    periodId: Uint32,
    committeeId: CommitteeId,
    votingStart: Uint32,
    votingEnd: Uint32,
  ): void {
    ensure(this.registryApp.value === 0, errAlreadyInit)
    ensure(Txn.sender === Global.creatorAddress, errUnauthorized)
    this.registryApp.value = registryApp.id
    this.periodId.value = periodId.asUint64()
    this.committeeId.value = committeeId
    this.votingStart.value = votingStart.asUint64()
    this.votingEnd.value = votingEnd.asUint64()
    this.topicOptionsArr.value = [] as GGovTopicOptions[]
    this.topicVotesArr.value = [] as GGovTopicVotes[]
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Inner-call the registry's verifyOperator and ensure caller is the operator. */
  protected ensureCallerIsOperator(): void {
    const ok = compileArc4(GGovRegistryContract).call.verifyOperator({
      appId: Application(this.registryApp.value),
      args: [Txn.sender],
    }).returnValue
    ensure(ok, errNotOperator)
  }

  /** Inner-call the registry's verifyAdmin and ensure caller is the admin. */
  protected checkAdminCaller(): void {
    const ok = compileArc4(GGovRegistryContract).call.verifyAdmin({
      appId: Application(this.registryApp.value),
      args: [Txn.sender],
    }).returnValue
    ensure(ok, errUnauthorized)
  }

  /** Mirror current summary (votingStart, votingEnd, numTopics, ready) onto the registry. */
  protected syncSummaryToRegistry(): void {
    compileArc4(GGovRegistryContract).call.updatePeriodSummary({
      appId: Application(this.registryApp.value),
      args: [
        u32(this.periodId.value),
        u32(this.votingStart.value),
        u32(this.votingEnd.value),
        u32(this.topicOptionsArr.value.length),
        this.ready.value,
      ],
    })
  }

  /** Guard for operator edits: period must not be ready */
  protected ensureEditable(): void {
    ensure(!this.ready.value, errGGovReady)
  }

  // ── Operator: period/topic CRUD ──────────────────────────────────

  public editPeriod(committeeId: CommitteeId, votingStart: uint64, votingEnd: uint64): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    ensure(votingEnd > votingStart, errPeriodEndLessThanStart)
    this.committeeId.value = committeeId
    this.votingStart.value = votingStart
    this.votingEnd.value = votingEnd
    this.syncSummaryToRegistry()
  }

  public addTopic(options: string[]): uint64 {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    ensure(options.length > 0, errGGovNoOptions)

    const votes: Uint32[] = []
    for (let i: uint64 = 0; i < options.length; i++) {
      votes.push(u32(0))
    }
    const newOptions: GGovTopicOptions = { options: clone(options) }
    const newVotes: GGovTopicVotes = { votes: clone(votes) }
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    const topicIndex: uint64 = optionsArr.length
    optionsArr.push(clone(newOptions))
    votesArr.push(clone(newVotes))
    this.topicOptionsArr.value = clone(optionsArr)
    this.topicVotesArr.value = clone(votesArr)
    this.syncSummaryToRegistry()
    return topicIndex
  }

  public editTopic(topicIndex: uint64, options: string[]): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    ensure(options.length > 0, errGGovNoOptions)
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    ensure(topicIndex < optionsArr.length, errGGovTopicIndexOOB)

    const votes: Uint32[] = []
    for (let i: uint64 = 0; i < options.length; i++) {
      votes.push(u32(0))
    }
    optionsArr[topicIndex] = { options: clone(options) }
    votesArr[topicIndex] = { votes: clone(votes) }
    this.topicOptionsArr.value = clone(optionsArr)
    this.topicVotesArr.value = clone(votesArr)
  }

  /** Remove the topic at $topicIndex. Operator only; only allowed while editable. */
  public removeTopic(topicIndex: uint64): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    ensure(topicIndex < optionsArr.length, errGGovTopicIndexOOB)
    const nextOptions: GGovTopicOptions[] = []
    const nextVotes: GGovTopicVotes[] = []
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      if (i !== topicIndex) {
        nextOptions.push(clone(optionsArr[i]))
        nextVotes.push(clone(votesArr[i]))
      }
    }
    this.topicOptionsArr.value = clone(nextOptions)
    this.topicVotesArr.value = clone(nextVotes)
    this.syncSummaryToRegistry()
  }

  /** Set the ready flag. Once ready=true, edits are blocked and voting becomes possible. Operator only. */
  public setReady(ready: boolean): void {
    this.ensureCallerIsOperator()
    const votesArr = clone(this.topicVotesArr.value)
    if (ready) {
      // A vote() must submit a row for every topic and emits the ARC-28 GGovVoteCast event carrying
      // the full per-topic breakdown. A single app call may log at most 1024 bytes, so if that event
      // would overflow, the period could never be voted on. The encoded size depends only on the
      // topic/option shape (known now), so reject readiness up-front rather than at vote time.
      //
      // GGovVoteCast = 4-byte ARC-28 prefix + ARC-4 (address,address,bool,uint64,uint32[][]):
      //   81 bytes fixed = 4 prefix + 75 head (32+32+1+8 + 2-byte tail offset) + 2-byte outer count,
      //   plus per topic (4 + 4·numOptions) = 2-byte element offset + 2-byte row length + numOptions·uint32.
      let logSize: uint64 = 81
      for (let i: uint64 = 0; i < votesArr.length; i++) {
        logSize += 4 + 4 * votesArr[i].votes.length
      }
      ensure(logSize <= 1024, errGGovUnvotable)
    } else {
      // ensure no votes have been cast yet (only votes box loaded — options skipped)
      for (let i: uint64 = 0; i < votesArr.length; i++) {
        const tallies = clone(votesArr[i].votes)
        for (let j: uint64 = 0; j < tallies.length; j++) {
          ensure(tallies[j].asUint64() === 0, errGGovHasVotes)
        }
      }
    }
    this.ready.value = ready
    this.syncSummaryToRegistry()
  }

  // ── Operator: body uploads ───────────────────────────────────────

  public uploadPeriodBodyPartial(startOffset: uint64, data: bytes, last: boolean): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const boxKey = Bytes`P`
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

  public uploadTopicBodyPartial(topicIndex: uint64, startOffset: uint64, data: bytes, last: boolean): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const boxKey = Bytes`T`.concat(encodeArc4(u32(topicIndex)))
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

  // ── Voting ───────────────────────────────────────────────────────
  /**
   * Public voting method. Period must be ready=true and within the voting window.
   * Sender can be the voter (not delegated) or the delegatee (delegated). Delegation is verified via an inner-call to the registry.
   * Votes are tallied into global topic vote counts, and the voter's individual vote record is updated.
   * Re-votes are allowed and will overwrite the previous vote; if re-voting via delegation, the delegation override guard applies (a delegatee cannot override a direct vote by the delegator). 
   * @param voterAccount Account with voting power
   * @param topicVotes Votes per topic, parallel to the period's topics/options. Each topic's votes are an array of Uint32, parallel to that topic's options, with the count of votes for each option. The sum of every topic's votes must equal the voter's total voting power (enforced in code, not ABI).
   */
  public vote(voterAccount: Account, topicVotes: Uint32[][]): void {
    ensure(this.ready.value, errGGovNotReady)
    ensure(Global.latestTimestamp >= this.votingStart.value, errGGovVotingNotStarted)
    ensure(Global.latestTimestamp < this.votingEnd.value, errGGovVotingEnded)
    
    const newTopicVotes = clone(topicVotes) // renaming for clarity. noop in approval

    // Delegation check (inner-call registry)
    let isDelegated = false
    if (Txn.sender !== voterAccount) {
      const expectedDelegatee = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: Application(this.registryApp.value),
        args: [voterAccount],
      }).returnValue
      ensure(expectedDelegatee === Txn.sender, errGGovNoDelegation)
      // If the sender is a delegatee, ensure the voterAccount is in the foreign-accounts array so
      // delegated voting can be "seen" in indexers, explorers, etc. Index 0 is the sender, so the
      // first referenced foreign account is Txn.accounts(1).
      ensure(Txn.numAccounts > 0 && Txn.accounts(1) === voterAccount, errGGovDelegationNoAcctRef)
      isDelegated = true
    }

    // Voting power (inner-call registry — throws errAccountNotExists if voter unknown)
    const votingPower = compileArc4(GGovRegistryContract).call.getXGovVotingPower({
      appId: Application(this.registryApp.value),
      args: [this.committeeId.value, voterAccount],
    }).returnValue

    // Global topic votes
    const globalVotesArr = clone(this.topicVotesArr.value)
    ensure(newTopicVotes.length === globalVotesArr.length, errGGovVoteMismatch)

    // if voter record box exists, it is a re-vote; subtract old votes from global tallies
    // If the existing record is by original votes (isDelegated=false), a delegatee cannot override it.
    const voteRecordBox = this.voteRecords(voterAccount)
    if (voteRecordBox.exists) {
      const existingRecord = clone(voteRecordBox.value)
      if (isDelegated && !existingRecord.isDelegated) {
        log(errGGovCannotOverride)
        err()
      }
      for (let i: uint64 = 0; i < existingRecord.topicVotes.length; i++) {
        const oldTopicVotes = clone(existingRecord.topicVotes[i])
        const currentVotes = clone(globalVotesArr[i].votes)
        const subtractedVotes: Uint32[] = []
        for (let j: uint64 = 0; j < oldTopicVotes.length; j++) {
          subtractedVotes.push(u32(currentVotes[j].asUint64() - oldTopicVotes[j].asUint64()))
        }
        globalVotesArr[i] = { votes: clone(subtractedVotes) }
      }
    }

    // Tally new votes & check that the sum of each topic's votes equals the voter's total voting power
    for (let i: uint64 = 0; i < newTopicVotes.length; i++) {
      const topicVote = clone(newTopicVotes[i])
      ensure(topicVote.length === globalVotesArr[i].votes.length, errGGovVoteMismatch)
      let voteSum: uint64 = 0
      const currentGlobalVotes = clone(globalVotesArr[i].votes)
      const nextGlobalVotes: Uint32[] = []
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        nextGlobalVotes.push(u32(currentGlobalVotes[j].asUint64() + topicVote[j].asUint64()))
        voteSum += topicVote[j].asUint64()
      }
      ensure(voteSum === votingPower.asUint64(), errGGovVotePowerMismatch)
      globalVotesArr[i] = { votes: clone(nextGlobalVotes) }
    }

    // emit event - BEFORE writing voteRecordBox; firstVote works without new var assignment
    emit<GGovVoteCast>({
      voter: voterAccount,
      sender: Txn.sender,
      updateVote: voteRecordBox.exists,
      votingPower: votingPower.asUint64(),
      topicVotes: clone(newTopicVotes),
    })

    // Update actual voting rounds in global storage
    if (this.firstVotingRound.value === 0) {
      this.firstVotingRound.value = Global.round
    }
    this.lastVotingRound.value = Global.round

    this.topicVotesArr.value = clone(globalVotesArr)
    voteRecordBox.value = {
      isDelegated: isDelegated,
      topicVotes: clone(newTopicVotes),
    }
  }

  /** Whether an account can vote and the resulting voting power. Returns [false, 0] in any rejection case. */
  @abimethod({ readonly: true })
  public canVote(voterAccount: Account, senderAccount: Account): [boolean, uint64] {
    if (!this.ready.value) return [false, 0]
    if (Global.latestTimestamp < this.votingStart.value) return [false, 0]
    if (Global.latestTimestamp >= this.votingEnd.value) return [false, 0]

    if (senderAccount !== voterAccount) {
      const delegate = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: Application(this.registryApp.value),
        args: [voterAccount],
      }).returnValue
      if (delegate === Global.zeroAddress) return [false, 0]
      if (delegate !== senderAccount) return [false, 0]
      // Mirror vote()'s override guard: a delegatee cannot override a vote the voter cast
      // directly. If a direct vote record (isDelegated=false) already exists, the delegatee
      // is not eligible — surface that here so canVote agrees with what vote() will enforce.
      const recordBox = this.voteRecords(voterAccount)
      if (recordBox.exists && !recordBox.value.isDelegated) return [false, 0]
    }

    const power = compileArc4(GGovRegistryContract).call.tryGetXGovVotingPower({
      appId: Application(this.registryApp.value),
      args: [this.committeeId.value, voterAccount],
    }).returnValue
    if (power.asUint64() === 0) return [false, 0]
    return [true, power.asUint64()]
  }

  // ── Read methods ─────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public getPeriod(): GGovPeriod {
    if (this.registryApp.value === 0) return getEmptyGGovPeriod()
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    const topics: GGovTopic[] = []
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      topics.push({ options: clone(optionsArr[i].options), votes: clone(votesArr[i].votes) })
    }
    return {
      committeeId: this.committeeId.value,
      votingStart: u32(this.votingStart.value),
      votingEnd: u32(this.votingEnd.value),
      topics: clone(topics),
    }
  }

  /**
   * Log the full period across many log lines instead of one ARC-4 return value.
   * getPeriod() returns the whole period as a single logged value, which overflows the
   * 1024-byte per-call ABI return limit once the topics get large (~22 Yes/No/Abstain topics).
   * logPeriod logs the header (GGovPeriodMeta) first, then one GGovTopic per line, so a
   * reader simulating with allowMoreLogging can reconstruct an arbitrarily large period.
   */
  @abimethod({ readonly: true })
  public logPeriod(): void {
    if (this.registryApp.value === 0) return
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    const meta: GGovPeriodMeta = {
      committeeId: this.committeeId.value,
      votingStart: u32(this.votingStart.value),
      votingEnd: u32(this.votingEnd.value),
      numTopics: u32(optionsArr.length),
    }
    log(encodeArc4(meta))
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      const topic: GGovTopic = { options: clone(optionsArr[i].options), votes: clone(votesArr[i].votes) }
      log(encodeArc4(topic))
    }
  }

  @abimethod({ readonly: true })
  public getVotingRecord(account: Account): GGovVoteRecord {
    const box = this.voteRecords(account)
    if (box.exists) return box.value
    return getEmptyGGovVoteRecord()
  }

  /**
   * Log a full vote record across many log lines instead of one ARC-4 return value.
   * getVotingRecord() returns the whole record as a single logged value, which overflows the
   * 1024-byte per-call ABI return limit once topicVotes gets large (same failure mode as
   * getPeriod/logPeriod). logVotingRecord logs the header (GGovVoteRecordMeta) first, then one
   * topic's votes (GGovTopicVotes) per line, so a reader simulating with allowMoreLogging can
   * reconstruct an arbitrarily large record. No logs at all means no record exists.
   */
  @abimethod({ readonly: true })
  public logVotingRecord(account: Account): void {
    const box = this.voteRecords(account)
    if (!box.exists) return
    const record = clone(box.value)
    const meta: GGovVoteRecordMeta = {
      isDelegated: record.isDelegated,
      numTopics: u32(record.topicVotes.length),
    }
    log(encodeArc4(meta))
    for (let i: uint64 = 0; i < record.topicVotes.length; i++) {
      const topicVotes: GGovTopicVotes = { votes: clone(record.topicVotes[i]) }
      log(encodeArc4(topicVotes))
    }
  }

  // ── Admin: withdraw ALGO (via registry C2C verifyAdmin) ──────────

  /**
   * Withdraw $amount microALGO from this period app account to $receiver. Registry admin
   * only (verified via inner call to registry.verifyAdmin). The AVM rejects the inner
   * payment if it would drop the app account below its min balance.
   */
  public withdrawALGO(receiver: Account, amount: uint64): void {
    this.checkAdminCaller()
    ensure(receiver !== Global.zeroAddress, errUnauthorized)
    itxn.payment({ receiver, amount }).submit()
  }

  // ── Lifecycle: update + delete (admin only, via registry C2C) ────

  /** App updatable by registry admin (verified via inner call to registry.verifyAdmin) */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.checkAdminCaller()
  }

  /** App deletable by registry admin (verified via inner call to registry.verifyAdmin) */
  @baremethod({ allowActions: ['DeleteApplication'] })
  public deleteApplication(): void {
    this.checkAdminCaller()
    // TODO: inner-call the registry to remove this period's summary box so deleted periods
    // drop out of getAllPeriods/getAllPeriodSummaries (which filter on appId === 0).
    // Requires a deletePeriod/removePeriod method on GGovRegistryContract.
  }
}
