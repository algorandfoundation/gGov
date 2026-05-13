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

  /** Topics array with inlined vote tallies */
  topicsArr = Box<GGovTopic[]>({ key: 't' })
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
    this.topicsArr.value = [] as GGovTopic[]
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
        u32(this.topicsArr.value.length),
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
    const topic: GGovTopic = {
      options: clone(options),
      votes: clone(votes),
    }
    const arr = clone(this.topicsArr.value)
    const topicIndex: uint64 = arr.length
    arr.push(clone(topic))
    this.topicsArr.value = clone(arr)
    this.syncSummaryToRegistry()
    return topicIndex
  }

  public editTopic(topicIndex: uint64, options: string[]): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    ensure(options.length > 0, errGGovNoOptions)
    const arr = clone(this.topicsArr.value)
    ensure(topicIndex < arr.length, errGGovTopicIndexOOB)

    const votes: Uint32[] = []
    for (let i: uint64 = 0; i < options.length; i++) {
      votes.push(u32(0))
    }
    arr[topicIndex] = {
      options: clone(options),
      votes: clone(votes),
    }
    this.topicsArr.value = clone(arr)
  }

  /** Remove the topic at $topicIndex. Operator only; only allowed while editable. */
  public removeTopic(topicIndex: uint64): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const arr = clone(this.topicsArr.value)
    ensure(topicIndex < arr.length, errGGovTopicIndexOOB)
    const next: GGovTopic[] = []
    for (let i: uint64 = 0; i < arr.length; i++) {
      if (i !== topicIndex) {
        next.push(clone(arr[i]))
      }
    }
    this.topicsArr.value = clone(next)
    this.syncSummaryToRegistry()
  }

  /** Set the ready flag. Once ready=true, edits are blocked and voting becomes possible. Operator only. */
  public setReady(ready: boolean): void {
    this.ensureCallerIsOperator()
    // If setting ready=false, ensure no votes have been cast yet
    if (!ready) {
      const topics = clone(this.topicsArr.value)
      for (let i: uint64 = 0; i < topics.length; i++) {
        const topic = clone(topics[i])
        for (let j: uint64 = 0; j < topic.votes.length; j++) {
          ensure(topic.votes[j].asUint64() === 0, errGGovHasVotes)
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

    const topicsArr = clone(this.topicsArr.value)
    ensure(topicVotes.length === topicsArr.length, errGGovVoteMismatch)

    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      ensure(topicVote.length === topicsArr[i].options.length, errGGovVoteMismatch)
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
        const currentVotes = clone(topicsArr[i].votes)
        const subtractedVotes: Uint32[] = []
        for (let j: uint64 = 0; j < oldTopicVotes.length; j++) {
          subtractedVotes.push(u32(currentVotes[j].asUint64() - oldTopicVotes[j].asUint64()))
        }
        topicsArr[i] = { options: clone(topicsArr[i].options), votes: clone(subtractedVotes) }
      }
    }

    // Add new votes
    const newTopicVotes: Uint32[][] = []
    for (let i: uint64 = 0; i < topicVotes.length; i++) {
      const topicVote = clone(topicVotes[i])
      const currentVotes = clone(topicsArr[i].votes)
      const newVotes: Uint32[] = []
      const recordRow: Uint32[] = []
      for (let j: uint64 = 0; j < topicVote.length; j++) {
        newVotes.push(u32(currentVotes[j].asUint64() + topicVote[j]))
        recordRow.push(u32(topicVote[j]))
      }
      topicsArr[i] = { options: clone(topicsArr[i].options), votes: clone(newVotes) }
      newTopicVotes.push(clone(recordRow))
    }

    this.topicsArr.value = clone(topicsArr)
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
    return {
      committeeId: this.committeeId.value,
      votingStart: u32(this.votingStart.value),
      votingEnd: u32(this.votingEnd.value),
      topics: clone(this.topicsArr.value),
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
