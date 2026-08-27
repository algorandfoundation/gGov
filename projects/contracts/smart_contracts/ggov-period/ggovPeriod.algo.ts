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
  Global,
  GlobalState,
  itxn,
  log,
  loggedAssert,
  loggedErr,
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
  errGGovLastOptionAbstain,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
  errGGovTopicIndexOOB,
  errGGovUnvotable,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingEnded,
  errGGovVotingNotStarted,
  errPeriodEndLessThanStart,
  errRegistryMissing,
  errUnauthorized,
} from '../base/errors.algo'
import {
  CommitteeId,
  getEmptyGGovPeriod,
  getEmptyGGovPeriodShort,
  getEmptyGGovVoteRecord,
  GGovPeriod,
  GGovPeriodMeta,
  GGovPeriodShort,
  GGovTopic,
  GGovTopicOptions,
  GGovTopicVotes,
  GGovVoteCast,
  GGovVoteRecord,
  GGovVoteRecordMeta,
} from '../base/types.algo'
import { u32 } from '../base/utils.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'

const TOPIC_BODY_BOX_PREFIX = Bytes`T`

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

  /** Per-topic option labels. Mutated only while editable. Parallel to topicVotesArr (same length & order). Last option is always Abstain (enforced). */
  topicOptionsArr = Box<GGovTopicOptions[]>({ key: 'o' })
  /**
   * Vote tallies, FLAT: every topic's options concatenated in topic order. Mutated on every vote().
   * Shaped by topicLengths, which is parallel to topicOptionsArr.
   *
   * Flat rather than `GGovTopicVotes[]`: a nested ARC-4 array pays an offset-table lookup plus a
   * per-row decode/encode on every element access, which is what dominates vote()'s opcode cost.
   */
  topicVotesArr = Box<Uint32[]>({ key: 't' })
  /**
   * Per-topic option counts, parallel to topicOptionsArr — the shape that turns the flat tallies
   * back into rows. Maintained by the topic CRUD; kept as its own box so vote() can read the shape
   * without decoding the (string-heavy) topicOptionsArr.
   */
  topicLengths = Box<Uint32[]>({ key: 'l' })
  /** Period body JSON (chunked) */
  periodBody = Box<bytes>({ key: 'P' })
  /** Topic body JSON by topicIndex */
  topicBodies = BoxMap<Uint32, bytes>({ keyPrefix: TOPIC_BODY_BOX_PREFIX }) // squatting key prefix to avoid collisions; code uses op.Box for splicing/resizing
  /** Per-voter vote record, keyed by voter Account. MBR is pulled from the registry on demand via `checkNeedMBR`. */
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
    loggedAssert(this.registryApp.value === 0, errAlreadyInit)
    loggedAssert(Txn.sender === Global.creatorAddress, errUnauthorized)
    this.registryApp.value = registryApp.id
    this.periodId.value = periodId.asUint64()
    this.committeeId.value = committeeId
    this.votingStart.value = votingStart.asUint64()
    this.votingEnd.value = votingEnd.asUint64()
    this.topicOptionsArr.value = [] as GGovTopicOptions[]
    this.topicVotesArr.value = [] as Uint32[]
    this.topicLengths.value = [] as Uint32[]
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Admin is the registry's `admin` global, read directly from the registry app's state (no inner
   * call). `admin` has an initial value on the registry, so a missing key means `registryApp` isn't
   * a registry — surface that as errRegistryMissing.
   */
  protected resolveAdmin(): Account {
    const [value, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`admin`)
    loggedAssert(exists, errRegistryMissing)
    return Account(value)
  }

  /**
   * Operator is the registry's `operator` global, read directly (no inner call). Unlike `admin`,
   * the registry's `operator` has no initial value, so before setOperator the key is absent; return
   * the zero address in that case so an operator-gated caller fails the comparison with errUnauthorized
   * (as under the old c2c check), rather than errRegistryMissing.
   */
  protected resolveOperator(): Account {
    const [value, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`operator`)
    return exists ? Account(value) : Global.zeroAddress
  }

  /**
   * Caller must match the registry's admin (`BaseContract` override). The creator — the spawning
   * registry app account — always passes too: a permanent escape hatch, mirroring
   * FracDelegationInstance.
   */
  protected override ensureCallerIsAdmin(): void {
    if (Txn.sender === Global.creatorAddress) return
    loggedAssert(Txn.sender === this.resolveAdmin(), errUnauthorized)
  }

  /** Caller must match the registry's operator. */
  protected ensureCallerIsOperator(): void {
    loggedAssert(Txn.sender === this.resolveOperator(), errUnauthorized)
  }

  /**
   * Post-condition: if this app account is at or below its minimum balance, pull a top-up from the
   * registry. The minimum balance requirement itself is enforced for the transaction as a whole, so
   * an app's account `balance` can be lower than its `minBalance` within the execution of the (outer)
   * transaction.
   *
   * NOTE: pays its own fee, against the usual `fee: 0` pooling rule. The top-up is conditional on a
   * balance another voter can move between simulate and execution, so with pooling a group that
   * simulated without it could not cover the extra fee. Own fees make the voter's group fee invariant.
   * Its counterpart does the same - see `GGovRegistry.requestMBR`.
   */
  protected checkNeedMBR(): void {
    const app = Global.currentApplicationAddress
    if (app.balance > app.minBalance) return
    compileArc4(GGovRegistryContract).call.requestMBR({
      appId: Application(this.registryApp.value),
      args: [u32(this.periodId.value)],
      fee: Global.minTxnFee,
    })
  }

  /**
   * Caller must match either gate. Used by deleteTopicBodies, which serves two callers: the admin
   * clearing every body box before deletePeriodApp, and the operator re-aligning body boxes after a
   * removeTopic. Granting the operator nothing new — while editable it can already delete any body
   * box via uploadTopicBodyPartial, whose startOffset-0 path is a box delete + create — and freed
   * min-balance accrues to the app account, never to the caller. Both resolvers read the registry's
   * global state directly, so the extra check costs no inner call.
   */
  protected ensureCallerIsOperatorOrAdmin(): void {
    if (Txn.sender === Global.creatorAddress) return
    if (Txn.sender === this.resolveOperator()) return
    loggedAssert(Txn.sender === this.resolveAdmin(), errUnauthorized)
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
    loggedAssert(!this.ready.value, errGGovReady)
  }

  /** Box key for the topic-body box of $topicIndex: 'T' + the ARC-4 uint32 index. */
  protected topicBodyBoxKey(topicIndex: uint64): bytes {
    return TOPIC_BODY_BOX_PREFIX.concat(encodeArc4(u32(topicIndex)))
  }

  /**
   * Validate a topic's option list: non-empty, ending in the literal 'Abstain', and carrying
   * 'Abstain' exactly once. This is an enforcement, not convention: `FracDelegationInstance`
   * relies on the last option being Abstain when casting instance votes, so relaxing this
   * check would silently corrupt pooled tallies. Called by `addTopic` and `editTopic`, the
   * only writers of an option list.
   */
  protected ensureValidOptions(options: string[]): void {
    loggedAssert(options.length > 0, errGGovNoOptions)
    const lastIndex: uint64 = options.length - 1
    loggedAssert(options[lastIndex] === 'Abstain', errGGovLastOptionAbstain)
    for (let i: uint64 = 0; i < lastIndex; i++) {
      loggedAssert(options[i] !== 'Abstain', errGGovLastOptionAbstain)
    }
  }

  /** A flat, zero-filled tally sized to `lengths` (one cell per option across every topic). */
  private zeroedCells(lengths: Uint32[]): Uint32[] {
    const cells: Uint32[] = []
    for (let t: uint64 = 0; t < lengths.length; t++) {
      for (let o: uint64 = 0; o < lengths[t].asUint64(); o++) {
        cells.push(u32(0))
      }
    }
    return cells
  }

  // ── Operator: period/topic CRUD ──────────────────────────────────

  public editPeriod(committeeId: CommitteeId, votingStart: uint64, votingEnd: uint64): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    loggedAssert(votingEnd > votingStart, errPeriodEndLessThanStart)
    this.committeeId.value = committeeId
    this.votingStart.value = votingStart
    this.votingEnd.value = votingEnd
    this.syncSummaryToRegistry()
  }

  public addTopic(options: string[]): uint64 {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    this.ensureValidOptions(options)

    const newOptions: GGovTopicOptions = { options: clone(options) }
    const optionsArr = clone(this.topicOptionsArr.value)
    const votesArr = clone(this.topicVotesArr.value)
    const lengths = clone(this.topicLengths.value)
    const topicIndex: uint64 = optionsArr.length
    optionsArr.push(clone(newOptions))
    for (let i: uint64 = 0; i < options.length; i++) {
      votesArr.push(u32(0))
    }
    lengths.push(u32(options.length))
    this.topicOptionsArr.value = clone(optionsArr)
    this.topicVotesArr.value = clone(votesArr)
    this.topicLengths.value = clone(lengths)
    this.syncSummaryToRegistry()
    return topicIndex
  }

  public editTopic(topicIndex: uint64, options: string[]): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const optionsArr = clone(this.topicOptionsArr.value)
    const lengths = clone(this.topicLengths.value)
    loggedAssert(topicIndex < optionsArr.length, errGGovTopicIndexOOB)
    // Same enforcement as addTopic — the option list is fully replaced
    this.ensureValidOptions(options)

    optionsArr[topicIndex] = { options: clone(options) }
    lengths[topicIndex] = u32(options.length)
    this.topicOptionsArr.value = clone(optionsArr)
    this.topicLengths.value = clone(lengths)
    // Editable implies no votes have been cast (setReady(false) rejects a voted period), so the
    // flat tallies are all zero and can simply be rebuilt at the new width.
    this.topicVotesArr.value = clone(this.zeroedCells(lengths))
  }

  /** Remove the topic at $topicIndex. Operator only; only allowed while editable. */
  public removeTopic(topicIndex: uint64): void {
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const optionsArr = clone(this.topicOptionsArr.value)
    const lengths = clone(this.topicLengths.value)
    loggedAssert(topicIndex < optionsArr.length, errGGovTopicIndexOOB)
    const nextOptions: GGovTopicOptions[] = []
    const nextLengths: Uint32[] = []
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      if (i !== topicIndex) {
        nextOptions.push(clone(optionsArr[i]))
        nextLengths.push(lengths[i])
      }
    }
    this.topicOptionsArr.value = clone(nextOptions)
    this.topicLengths.value = clone(nextLengths)
    // Editable implies zero tallies (see editTopic), so rebuild the flat cells at the new width.
    this.topicVotesArr.value = clone(this.zeroedCells(nextLengths))
    this.syncSummaryToRegistry()
  }

  /** Set the ready flag. Once ready=true, edits are blocked and voting becomes possible. Operator only. */
  public setReady(ready: boolean): void {
    this.ensureCallerIsOperator()
    const votesArr = clone(this.topicVotesArr.value)
    if (ready) {
      // A vote() submits one cell per option across every topic and emits the ARC-28 GGovVoteCast
      // event carrying the full breakdown. A single app call may log at most 1024 bytes, so if that
      // event would overflow, the period could never be voted on. The encoded size depends only on
      // the topic/option shape (known now), so reject readiness up-front rather than at vote time.
      //
      // GGovVoteCast = 4-byte ARC-28 prefix + ARC-4 (address,address,bool,uint64,uint32[]):
      //   81 bytes fixed = 4 prefix + 75 head (32+32+1+8 + 2-byte tail offset) + 2-byte array count,
      //   plus 4 bytes per option cell. Flattening dropped the per-topic 4-byte offset+length pair,
      //   so a flat period fits strictly more topics than a nested one did.
      const logSize: uint64 = 81 + 4 * votesArr.length
      loggedAssert(logSize <= 1024, errGGovUnvotable)
    } else {
      // ensure no votes have been cast yet (only votes box loaded — options skipped)
      for (let i: uint64 = 0; i < votesArr.length; i++) {
        loggedAssert(votesArr[i].asUint64() === 0, errGGovHasVotes)
      }
    }
    this.ready.value = ready
    this.syncSummaryToRegistry()
  }

  // ── Operator: body uploads ───────────────────────────────────────

  public uploadPeriodBodyPartial(startOffset: uint64, data: bytes): void {
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

  public uploadTopicBodyPartial(topicIndex: uint64, startOffset: uint64, data: bytes): void {
    // topicBodies is declared as BoxMap in the class to surface collisions with the box prefix in the type system
    // but we have to use op.Box here for the fine-grained control needed to splice in partial updates
    // so we use a helper to construct the full box key consistently between the two usages
    this.ensureCallerIsOperator()
    this.ensureEditable()
    const boxKey = this.topicBodyBoxKey(topicIndex)
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

  /**
   * Delete the topic-body boxes ('T'+index) for the given topic indexes. Operator or admin, and only
   * while not ready. Two callers: the admin clearing every body box before deletePeriodApp, so their
   * min-balance is reclaimed rather than permanently locked; and the operator re-aligning body boxes
   * after a removeTopic, which splices the topic arrays but cannot re-key the boxes — without this
   * the vacated tail box would survive and a later bodyless addTopic would inherit it. Paged ≤8 per
   * txn because of the 8-box-reference limit. op.Box.delete is a no-op for an absent box, so
   * unknown/stale indexes are harmless. Each referenced box must be in the txn's box-reference array.
   */
  public deleteTopicBodies(topicIndexes: uint64[]): void {
    this.ensureCallerIsOperatorOrAdmin()
    this.ensureEditable()
    for (const idx of clone(topicIndexes)) {
      op.Box.delete(this.topicBodyBoxKey(idx))
    }
  }

  // ── Voting ───────────────────────────────────────────────────────
  /**
   * Public voting method. Period must be ready=true and within the voting window.
   * Sender can be the voter (not delegated) or the delegatee (delegated). Delegation is verified via an inner-call to the registry.
   * Votes are tallied into global topic vote counts, and the voter's individual vote record is updated.
   * Re-votes are allowed and will overwrite the previous vote; if re-voting via delegation, the delegation override guard applies (a delegatee cannot override a direct vote by the delegator).
   *
   * Vote record MBR is paid by the period app account on an account's first vote. A top-up is requested from the registry via inner call when needed; see the `checkNeedMBR` post-condition.
   * @param voterAccount Account with voting power
   * @param topicVotes Votes as a FLAT Uint32[]: every topic's options concatenated in topic order, sized by the period's topicLengths. The sum of each topic's slice must equal the voter's total voting power (enforced in code, not ABI).
   */
  public vote(voterAccount: Account, topicVotes: Uint32[]): void {
    loggedAssert(this.ready.value, errGGovNotReady)
    loggedAssert(Global.latestTimestamp >= this.votingStart.value, errGGovVotingNotStarted)
    loggedAssert(Global.latestTimestamp < this.votingEnd.value, errGGovVotingEnded)

    const newTopicVotes = clone(topicVotes) // renaming for clarity. noop in approval

    // Delegation check (inner-call registry)
    let isDelegated = false
    if (Txn.sender !== voterAccount) {
      const expectedDelegatee = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: Application(this.registryApp.value),
        args: [voterAccount],
      }).returnValue
      loggedAssert(expectedDelegatee === Txn.sender, errGGovNoDelegation)
      // If the sender is a delegatee, ensure the voterAccount is in the foreign-accounts array so
      // delegated voting can be "seen" in indexers, explorers, etc. Index 0 is the sender, so the
      // first referenced foreign account is Txn.accounts(1).
      loggedAssert(Txn.numAccounts > 0 && Txn.accounts(1) === voterAccount, errGGovDelegationNoAcctRef)
      isDelegated = true
    }

    // Voting power (inner-call registry — throws errAccountNotExists if voter unknown)
    const votingPower = compileArc4(GGovRegistryContract).call.getGovVotingPower({
      appId: Application(this.registryApp.value),
      args: [this.committeeId.value, voterAccount],
    }).returnValue

    // Global tallies, flat: cell c of topic t lives at (offset of t) + c.
    const globalVotesArr = clone(this.topicVotesArr.value)
    loggedAssert(newTopicVotes.length === globalVotesArr.length, errGGovVoteMismatch)

    // if voter record box exists, it is a re-vote; subtract old votes from global tallies
    // If the existing record is by original votes (isDelegated=false), a delegatee cannot override it.
    const voteRecordBox = this.voteRecords(voterAccount)
    if (voteRecordBox.exists) {
      const existingRecord = clone(voteRecordBox.value)
      if (isDelegated && !existingRecord.isDelegated) {
        loggedErr(errGGovCannotOverride)
      }
      const oldVotes = clone(existingRecord.topicVotes)
      loggedAssert(oldVotes.length === globalVotesArr.length, errGGovVoteMismatch)
      for (let c: uint64 = 0; c < oldVotes.length; c++) {
        globalVotesArr[c] = u32(globalVotesArr[c].asUint64() - oldVotes[c].asUint64())
      }
    }

    // Tally new votes & check that each topic's slice sums to the voter's total voting power. One
    // pass over the flat cells, closing a topic whenever its boundary is reached.
    const lengths = clone(this.topicLengths.value)
    let cell: uint64 = 0
    for (let t: uint64 = 0; t < lengths.length; t++) {
      const width: uint64 = lengths[t].asUint64()
      let voteSum: uint64 = 0
      for (let o: uint64 = 0; o < width; o++) {
        const idx: uint64 = cell + o
        const cast: uint64 = newTopicVotes[idx].asUint64()
        globalVotesArr[idx] = u32(globalVotesArr[idx].asUint64() + cast)
        voteSum += cast
      }
      loggedAssert(voteSum === votingPower.asUint64(), errGGovVotePowerMismatch)
      cell += width
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
    // Must stay after the vote record write
    this.checkNeedMBR()
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

    const power = compileArc4(GGovRegistryContract).call.tryGetGovVotingPower({
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
    let cell: uint64 = 0
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      const width: uint64 = optionsArr[i].options.length
      const row: Uint32[] = []
      for (let o: uint64 = 0; o < width; o++) {
        row.push(votesArr[cell + o])
      }
      cell += width
      topics.push({ options: clone(optionsArr[i].options), votes: clone(row) })
    }
    return {
      committeeId: this.committeeId.value,
      votingStart: u32(this.votingStart.value),
      votingEnd: u32(this.votingEnd.value),
      topics: clone(topics),
    }
  }

  /** Short period information to be used by fractional delegator */
  @abimethod({ readonly: true })
  public getPeriodShort(): GGovPeriodShort {
    if (this.registryApp.value === 0) return getEmptyGGovPeriodShort()
    const topics = clone(this.topicOptionsArr.value)
    const lengths: Uint32[] = []
    for (let i: uint64 = 0; i < topics.length; i++) {
      lengths.push(u32(topics[i].options.length))
    }
    return {
      committeeId: this.committeeId.value,
      votingStart: u32(this.votingStart.value),
      votingEnd: u32(this.votingEnd.value),
      topicOptionLengths: lengths,
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
    let cell: uint64 = 0
    for (let i: uint64 = 0; i < optionsArr.length; i++) {
      const width: uint64 = optionsArr[i].options.length
      const row: Uint32[] = []
      for (let o: uint64 = 0; o < width; o++) {
        row.push(votesArr[cell + o])
      }
      cell += width
      const topic: GGovTopic = { options: clone(optionsArr[i].options), votes: clone(row) }
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
    const lengths = clone(this.topicLengths.value)
    const meta: GGovVoteRecordMeta = {
      isDelegated: record.isDelegated,
      numTopics: u32(lengths.length),
    }
    log(encodeArc4(meta))
    // The record is stored flat; the per-topic line shape is preserved for readers.
    let cell: uint64 = 0
    for (let t: uint64 = 0; t < lengths.length; t++) {
      const width: uint64 = lengths[t].asUint64()
      const row: Uint32[] = []
      for (let o: uint64 = 0; o < width; o++) {
        row.push(record.topicVotes[cell + o])
      }
      cell += width
      const topicVotes: GGovTopicVotes = { votes: clone(row) }
      log(encodeArc4(topicVotes))
    }
  }

  // ── Admin: withdraw ALGO ─────────────────────────────────────────

  /**
   * Withdraw $amount microALGO from this period app account to $receiver. Registry admin
   * only (resolved from the registry's `admin` global, or the creator escape hatch). The AVM
   * rejects the inner payment if it would drop the app account below its min balance.
   */
  public withdrawALGO(receiver: Account, amount: uint64): void {
    this.ensureCallerIsAdmin()
    itxn.payment({ receiver, amount }).submit()
  }

  // ── Lifecycle: update + delete (admin only) ──────────────────────

  /** App updatable by registry admin (resolved from the registry's `admin` global) */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.ensureCallerIsAdmin()
  }

  /**
   * App deletable by registry admin (resolved from the registry's `admin` global), and only
   * while the period is not ready. Blocking deletion on ready keeps a period that is locked for
   * voting from being torn down; to delete a ready period the admin must setReady(false) first,
   * which itself only succeeds when no votes have been cast.
   */
  @baremethod({ allowActions: ['DeleteApplication'] })
  public deleteApplication(): void {
    this.ensureCallerIsAdmin()
    this.ensureEditable()
    // delete boxes to reclaim their mbr
    // topicOptionsArr, topicVotesArr and topicLengths will always exist
    // periodBody may or may not exist
    this.topicOptionsArr.delete()
    this.topicVotesArr.delete()
    this.topicLengths.delete()
    if (this.periodBody.exists) this.periodBody.delete()
    // Inner-call the registry to remove this period's summary box so deleted periods drop out of
    // getAllPeriods/getAllPeriodSummaries (which filter on appId === 0).
    compileArc4(GGovRegistryContract).call.removePeriodSummary({
      appId: Application(this.registryApp.value),
      args: [u32(this.periodId.value)],
    })
    // Close out all escrow balance to caller
    itxn.payment({ receiver: Txn.sender, amount: 0, closeRemainderTo: Txn.sender }).submit()
  }
}
