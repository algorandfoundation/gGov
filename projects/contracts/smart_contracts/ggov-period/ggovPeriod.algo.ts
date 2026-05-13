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
  err,
  Global,
  GlobalState,
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
  errGGovHasVotes,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
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
  GGovTopic,
  GGovTopicOptions,
  GGovTopicVotes,
  GGovVoteRecord,
} from '../base/types.algo'
import { ensure, u32 } from '../base/utils.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'

@contract({ name: 'GGovPeriod' })
export class GGovPeriodContract extends BaseContract {
  /** Registry app ID. 0 sentinel = uninitialised */
  oracleApp = GlobalState<uint64>({ initialValue: 0 })
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
   * Can only be called once (oracleApp must still be 0); creator (the registry app account)
   * is the only allowed sender.
   */
  @abimethod()
  public init(
    oracleApp: Application,
    periodId: Uint32,
    committeeId: CommitteeId,
    votingStart: Uint32,
    votingEnd: Uint32,
  ): void {
    ensure(this.oracleApp.value === 0, errAlreadyInit)
    ensure(Txn.sender === Global.creatorAddress, errUnauthorized)
    this.oracleApp.value = oracleApp.id
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
      appId: Application(this.oracleApp.value),
      args: [Txn.sender],
    }).returnValue
    ensure(ok, errNotOperator)
  }

  /** Inner-call the registry's verifyAdmin and ensure caller is the admin. */
  protected checkAdminCaller(): void {
    const ok = compileArc4(GGovRegistryContract).call.verifyAdmin({
      appId: Application(this.oracleApp.value),
      args: [Txn.sender],
    }).returnValue
    ensure(ok, errUnauthorized)
  }

  /** Mirror current summary (votingStart, votingEnd, numTopics, ready) onto the registry. */
  protected syncSummaryToRegistry(): void {
    compileArc4(GGovRegistryContract).call.updatePeriodSummary({
      appId: Application(this.oracleApp.value),
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
    // If setting ready=false, ensure no votes have been cast yet (only votes box loaded — options skipped)
    if (!ready) {
      const votesArr = clone(this.topicVotesArr.value)
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

  public vote(voterAccount: Account, topicVotes: uint64[][]): void {
    ensure(this.ready.value, errGGovNotReady)
    ensure(Global.latestTimestamp >= this.votingStart.value, errGGovVotingNotStarted)
    ensure(Global.latestTimestamp < this.votingEnd.value, errGGovVotingEnded)

    // Delegation check (inner-call registry)
    let isDelegated = false
    if (Txn.sender !== voterAccount) {
      const delegate = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: Application(this.oracleApp.value),
        args: [voterAccount],
      }).returnValue
      ensure(delegate !== Global.zeroAddress, errGGovNoDelegation)
      ensure(delegate === Txn.sender, errGGovNoDelegation)
      isDelegated = true
    }

    // Voting power (inner-call registry — throws errAccountNotExists if voter unknown)
    const votingPower = compileArc4(GGovRegistryContract).call.getXGovVotingPower({
      appId: Application(this.oracleApp.value),
      args: [this.committeeId.value, voterAccount],
    }).returnValue

    // Hot path: load only the votes box. Option strings stay on-chain.
    const votesArr = clone(this.topicVotesArr.value)
    ensure(topicVotes.length === votesArr.length, errGGovVoteMismatch)

    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      ensure(topicVote.length === votesArr[i].votes.length, errGGovVoteMismatch)
      let voteSum: uint64 = 0
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        voteSum += topicVote[j]
      }
      ensure(voteSum === votingPower.asUint64(), errGGovVotePowerMismatch)
    }

    const voteRecordBox = this.voteRecords(voterAccount)

    // Handle existing record: subtract old votes from tallies
    if (voteRecordBox.exists) {
      const existingRecord = clone(voteRecordBox.value)
      if (isDelegated && !existingRecord.byDelegator) {
        log(errGGovCannotOverride)
        err()
      }
      for (let i: uint64 = 0; i < existingRecord.topicVotes.length; i++) {
        const oldTopicVotes = clone(existingRecord.topicVotes[i])
        const currentVotes = clone(votesArr[i].votes)
        const subtractedVotes: Uint32[] = []
        for (let j: uint64 = 0; j < oldTopicVotes.length; j++) {
          subtractedVotes.push(u32(currentVotes[j].asUint64() - oldTopicVotes[j].asUint64()))
        }
        votesArr[i] = { votes: clone(subtractedVotes) }
      }
    }

    // Add new votes
    const newTopicVotes: Uint32[][] = []
    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      const currentVotes = clone(votesArr[i].votes)
      const newVotes: Uint32[] = []
      const recordRow: Uint32[] = []
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        newVotes.push(u32(currentVotes[j].asUint64() + topicVote[j]))
        recordRow.push(u32(topicVote[j]))
      }
      votesArr[i] = { votes: clone(newVotes) }
      newTopicVotes.push(clone(recordRow))
    }

    this.topicVotesArr.value = clone(votesArr)
    voteRecordBox.value = {
      byDelegator: isDelegated,
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
        appId: Application(this.oracleApp.value),
        args: [voterAccount],
      }).returnValue
      if (delegate === Global.zeroAddress) return [false, 0]
      if (delegate !== senderAccount) return [false, 0]
    }

    const power = compileArc4(GGovRegistryContract).call.tryGetXGovVotingPower({
      appId: Application(this.oracleApp.value),
      args: [this.committeeId.value, voterAccount],
    }).returnValue
    if (power.asUint64() === 0) return [false, 0]
    return [true, power.asUint64()]
  }

  // ── Read methods ─────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public getPeriod(): GGovPeriod {
    if (this.oracleApp.value === 0) return getEmptyGGovPeriod()
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

  @abimethod({ readonly: true })
  public getVotingRecord(account: Account): GGovVoteRecord {
    const box = this.voteRecords(account)
    if (box.exists) return box.value
    return getEmptyGGovVoteRecord()
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
  }
}
