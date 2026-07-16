import {
  abimethod,
  Account,
  Application,
  baremethod,
  Box,
  BoxMap,
  Bytes,
  clone,
  contract,
  Global,
  GlobalState,
  itxn,
  log,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { compileArc4, encodeArc4, Uint16, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import {
  errCommitteeNotExists,
  errGGovHasVotes,
  errGGovNotReady,
  errGGovPeriodNotExists,
  errNoEscrows,
  errPeriodAppMismatch,
  errRegistryMissing,
  errUnauthorized,
} from '../base/errors.algo'
import {
  CommitteeId,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodEscrowKey,
  FracPeriodVoteCache,
} from '../base/types.algo'
import { ensure, u32, u8 } from '../base/utils.algo'
import { GGovPeriodContract } from '../ggov-period/ggovPeriod.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'

/**
 * Fractional Delegation Instance: per-protocol delegation contract.
 *
 * Resolves its admin and operator from the registry global state.
 */
@contract({ name: 'FracDelegationInstance' })
export class FracDelegationInstanceContract extends BaseContract {
  /** `FracDelegationRegistry` app ID; initialized at creator app ID (defaults to zero if non-app)*/
  registryApp = GlobalState<uint64>({ initialValue: Global.callerApplicationId })
  /** Instance operator; zero address falls back to the registry's `defaultOperator` */
  operator = GlobalState<Account>({ initialValue: Global.zeroAddress })
  /** Registry-assigned numeric ID for this instance. Set once at creation. */
  instanceNumId = GlobalState<Uint16>()
  /** Human-readable instance label. Set once at creation. */
  name = GlobalState<string>()
  /**
   * Escrow accounts registered against this instance. Written append-only by `registerEscrow`
   * (via the registry, or directly by the admin escape hatch). The registry mirrors the length
   * of this list in its per-instance `numEscrows` counter for cheap off-chain reads.
   */
  escrows = Box<Account[]>({ key: 'escrows' })
  /**
   * Per-committee snapshot of escrow voting power, synced from the gGov registry by
   * `syncCommittee`. Keyed by the 32-byte committee ID under the `c` prefix, matching the
   * gGov registry's own committees BoxMap.
   */
  committees = BoxMap<CommitteeId, FracInstanceCommittee>({ keyPrefix: 'c' })
  /**
   * Per-period snapshot of a gGov period's identity and topic shape, synced from the period app by
   * `syncPeriod`. Keyed by the gGov period ID.
   */
  periods = BoxMap<Uint32, FracInstancePeriod>({ keyPrefix: 'p' })
  /**
   * Per-period aggregate vote tallies, zero-filled by `syncPeriod` and accumulated as votes are
   * cast. Keyed by the gGov period ID, parallel to `periods`.
   */
  periodVoteCache = BoxMap<Uint32, FracPeriodVoteCache>({ keyPrefix: 'V' })
  /**
   * Per-escrow external gGov votes, keyed by [period ID, escrow index]. Zero-filled by
   * `syncPeriod`, one box per escrow of the committee snapshot the period is bound to.
   */
  periodEscrowVotes = BoxMap<FracPeriodEscrowKey, FracEscrowVotes>({ keyPrefix: 'E' })

  // ── Create ────────────────────────────────────────────────────────

  /**
   * Convention-based create. Records the registry-assigned numeric ID and label
   * passed as app arguments. `registryApp` and `operator` are seeded from their
   * GlobalState initial values (registry = creating app; operator = zero/fallback).
   * @param instanceNumId Numeric ID assigned by the registry
   * @param name Human-readable instance label
   */
  public createApplication(instanceNumId: Uint16, name: string): void {
    this.instanceNumId.value = instanceNumId
    this.name.value = name
  }

  // ── Role resolution ───────────────────────────────────────────────

  /** Instance admin is the registry's `admin` */
  protected resolveAdmin(): Account {
    const [value, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`admin`)
    ensure(exists, errRegistryMissing)
    return Account(value)
  }

  /**
   * Instance operator is the local `operator` override if set, otherwise falls
   * back to the registry's `defaultOperator`. May resolve to the zero address,
   * but in that case no caller passes `ensureCallerIsOperator`.
   */
  protected resolveOperator(): Account {
    if (this.operator.value === Global.zeroAddress) {
      const [value, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`defaultOperator`)
      ensure(exists, errRegistryMissing)
      return Account(value)
    }
    return this.operator.value
  }

  /**
   * Caller must match the resolved admin (`BaseContract` override). The creator always
   * passes too - this is an permanent escape hatch for the original spawning registry
   * to have control in case an unintended registry is set.
   */
  protected override ensureCallerIsAdmin(): void {
    if (Txn.sender === Global.creatorAddress) return
    ensure(Txn.sender === this.resolveAdmin(), errUnauthorized)
  }

  /** Caller must match the resolved operator. */
  protected ensureCallerIsOperator(): void {
    ensure(Txn.sender === this.resolveOperator(), errUnauthorized)
  }

  /**
   * gGov registry app to read committee data from, resolved from the registry's
   * `gGovRegistryApp` global state. Throws if the registry has not configured one yet.
   */
  protected resolveGGovRegistryApp(): Application {
    const [appId, exists] = op.AppGlobal.getExUint64(this.registryApp.value, Bytes`gGovRegistryApp`)
    ensure(exists && appId > 0, errRegistryMissing)
    return Application(appId)
  }

  /** Caller must be the configured registry application (inner app call). */
  protected ensureCallerIsRegistry(): void {
    ensure(this.registryApp.value > 0, errRegistryMissing)
    ensure(Global.callerApplicationId === this.registryApp.value, errUnauthorized)
  }

  /**
   * Caller must be the bound registry (inner call from `registryApp`) or the resolved admin.
   * Lets the registry drive `registerEscrow` on the instance while preserving a direct admin
   * escape hatch (the creator branch of `ensureCallerIsAdmin` still applies).
   */
  protected ensureCallerIsAdminOrRegistry(): void {
    if (this.registryApp.value > 0 && Global.callerApplicationId === this.registryApp.value) return
    this.ensureCallerIsAdmin()
  }

  @abimethod({ readonly: true })
  public getAdmin(): Account {
    return this.resolveAdmin()
  }

  @abimethod({ readonly: true })
  public getOperator(): Account {
    return this.resolveOperator()
  }

  // ── Admin ─────────────────────────────────────────────────────────

  /** Set the `operator` account. Admin only; zero address clears back to registry fallback. */
  public setOperator(newOperator: Account): void {
    this.ensureCallerIsAdmin()
    this.operator.value = newOperator
  }

  /**
   * Set the `registryApp` ID. Admin only. Validates the new registry exposes an `admin` key
   * before binding, so a bad `appId` can't brick role resolution. Note an nonexistent app will
   * revert on `app_global_get_ex`, so new registry must exist and have an `admin` key.
   * This is a migration path for the registry app. Always set the new registry before deleting
   * the old one (if so), never after - as admin auth could be bricked.
   */
  public setRegistryApp(appId: uint64): void {
    this.ensureCallerIsAdmin()
    const [_, exists] = op.AppGlobal.getExBytes(appId, Bytes`admin`)
    ensure(exists, errRegistryMissing)
    this.registryApp.value = appId
  }

  /**
   * Withdraw ALGO from the instance app account to `receiver`. Admin only.
   * The AVM rejects the inner payment if it would drop the app account below its min
   * balance, so over-withdrawal fails atomically (no explicit balance check needed).
   * @param receiver Destination account
   * @param amount microALGO to withdraw
   */
  public withdrawALGO(receiver: Account, amount: uint64): void {
    this.ensureCallerIsAdmin()
    itxn.payment({ receiver, amount }).submit()
  }

  // ── Escrows ───────────────────────────────────────────────────────

  /**
   * Append `account` to this instance's `escrows` list. Callable by the bound registry (the
   * normal path — `FracDelegationRegistry.registerEscrow`, which also keeps its per-instance
   * `numEscrows` counter in sync) or directly by the admin (escape hatch; a direct admin call
   * does NOT touch the registry counter, so prefer the registry path).
   *
   * Append-only: this method performs no de-duplication. On the normal path the registry
   * enforces globally-unique escrow assignment before calling here, so duplicates only arise if
   * the admin uses the direct escape hatch to register the same account twice.
   * @param account Escrow account to append
   */
  public registerEscrow(account: Account): void {
    this.ensureCallerIsAdminOrRegistry()
    const escrows = this.escrows.exists ? clone(this.escrows.value) : ([] as Account[])
    escrows.push(account)
    this.escrows.value = clone(escrows)
  }

  // ── Committees ────────────────────────────────────────────────────

  /**
   * Sync this instance's view of gGov committee `committeeId` from the gGov registry
   * (resolved from the frac registry's `gGovRegistryApp`). Operator only.
   *
   * Reads each registered escrow's voting power in the committee and writes the result to
   * `committees(committeeId)`: `escrowsVotes` index-synced with the `escrows` box, plus their sum
   * as `totalVotes`. Idempotent and safe to re-run — the box is rebuilt from scratch on every call,
   * so re-syncing after more escrows are registered picks the new ones up (and refreshes the
   * existing entries). Escrows are read with the non-throwing `tryGetGovVotingPower`, so an
   * escrow that is not a member of the committee simply contributes 0 rather than blocking
   * the whole sync.
   *
   * Requires at least one registered escrow, and requires the committee to be fully ingested on
   * the gGov registry (`mustBeComplete`), so a snapshot is never taken against a half-ingested
   * member set. The instance app account pays the box MBR, which grows with the escrow count —
   * keep it funded.
   * @param committeeId 32-byte gGov committee ID
   * @returns The synced committee record
   */
  public syncCommittee(committeeId: CommitteeId): FracInstanceCommittee {
    this.ensureCallerIsOperator()
    const gGovRegistryAppId = this.resolveGGovRegistryApp()

    // Nothing to snapshot without escrows. Checked before the first inner call so the failure
    // costs nothing, and so an empty record can never be written.
    const escrows = this.escrows.exists ? clone(this.escrows.value) : ([] as Account[])
    ensure(escrows.length > 0, errNoEscrows)

    const gGovRegistry = compileArc4(GGovRegistryContract)

    // An unknown committee returns empty metadata rather than throwing; numericId 0 is never
    // assigned by the registry, so it marks "no such committee".
    const committeeMetadata = gGovRegistry.call.getCommitteeMetadata({
      appId: gGovRegistryAppId,
      args: [committeeId, true],
    }).returnValue
    ensure(committeeMetadata.numericId.asUint64() > 0, errCommitteeNotExists)

    const escrowsVotes: Uint32[] = []
    let totalVotes: uint64 = 0
    for (const escrow of escrows) {
      const votes = gGovRegistry.call.tryGetGovVotingPower({
        appId: gGovRegistryAppId,
        args: [committeeId, escrow],
      }).returnValue
      escrowsVotes.push(votes)
      totalVotes += votes.asUint64()
    }

    const committee: FracInstanceCommittee = {
      committeeNumId: committeeMetadata.numericId,
      escrowsVotes: clone(escrowsVotes),
      totalVotes: u32(totalVotes),
    }
    this.committees(committeeId).value = clone(committee)
    return committee
  }

  // ── Periods ───────────────────────────────────────────────────────

  /**
   * Build a zero-filled [topic][option] tally shaped to `topicOptionLengths`.
   */
  private zeroedTopicShape(topicOptionLengths: Uint32[]): Uint32[][] {
    const shape: Uint32[][] = []
    for (let i: uint64 = 0; i < topicOptionLengths.length; i++) {
      const topic: Uint32[] = []
      for (let j: uint64 = 0; j < topicOptionLengths[i].asUint64(); j++) {
        topic.push(u32(0))
      }
      shape.push(clone(topic))
    }
    return shape
  }

  /**
   * Whether any vote has landed in `periodId`'s cache. Only the aggregate tallies are scanned:
   * `periodEscrowVotes` is a strict breakdown of `ggovTotals`, so it cannot be non-zero while both
   * aggregates are zero, and skipping it keeps this to a single box read.
   */
  private cacheHasVotes(periodId: Uint32): boolean {
    const cache = clone(this.periodVoteCache(periodId).value)
    for (let i: uint64 = 0; i < cache.internal.length; i++) {
      const topic = clone(cache.internal[i])
      for (let j: uint64 = 0; j < topic.length; j++) {
        if (topic[j].asUint64() > 0) return true
      }
    }
    for (let i: uint64 = 0; i < cache.ggovTotals.length; i++) {
      const topic = clone(cache.ggovTotals[i])
      for (let j: uint64 = 0; j < topic.length; j++) {
        if (topic[j].asUint64() > 0) return true
      }
    }
    return false
  }

  /**
   * Sync this instance's view of gGov period `periodApp` from the period contract. Operator only.
   *
   * Records the period's identity and topic shape in `periods(periodId)`, and stands up zero-filled
   * tallies in `periodVoteCache(periodId)` plus one `periodEscrowVotes([periodId, i])` box per
   * escrow, ready to receive votes.
   *
   * Requires the period's committee to already be synced locally (`syncCommittee`). That snapshot
   * supplies `committeeNumId` and the per-escrow voting power a later external vote splits pro-rata,
   * which is what keeps this method to a single inner call rather than one per escrow.
   *
   * Requires the period to be marked ready on the period app: topics stay editable until then, so
   * an earlier sync could cache a topic shape that later drifts out from under the tallies.
   *
   * Re-syncable, but only while no vote has landed yet - a rebuild would otherwise discard live
   * tallies. Re-syncing after `syncCommittee` picks up newly registered escrows widens the escrow
   * boxes to match. The instance app account pays the box MBR, which grows with escrow and topic
   * count - keep it funded.
   * @param periodApp The gGov period app to sync from
   * @returns The synced period record
   */
  public syncPeriod(periodApp: Application): FracInstancePeriod {
    this.ensureCallerIsOperator()

    // periodId and ready come straight off the period app's global state - getPeriodShort returns
    // neither. Mirrors resolveGGovRegistryApp's getEx* pattern. periodId has no initial value, so
    // its absence also rejects a non-period app before any inner call is made.
    const [periodId, hasPeriodId] = op.AppGlobal.getExUint64(periodApp, Bytes`periodId`)
    ensure(hasPeriodId, errGGovPeriodNotExists)
    const [ready, _hasReady] = op.AppGlobal.getExUint64(periodApp, Bytes`ready`)
    ensure(ready > 0, errGGovNotReady)

    const short = compileArc4(GGovPeriodContract).call.getPeriodShort({ appId: periodApp }).returnValue

    const committeeBox = this.committees(short.committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    const committee = clone(committeeBox.value)

    const key = u32(periodId)

    // A pristine cache may be rebuilt; one holding votes may not. Rebinding a period ID to a
    // different app is never valid, so reject it rather than silently repointing the record.
    if (this.periodVoteCache(key).exists) {
      ensure(this.periods(key).value.periodAppId === periodApp.id, errPeriodAppMismatch)
      ensure(!this.cacheHasVotes(key), errGGovHasVotes)
    }

    const period: FracInstancePeriod = {
      periodAppId: periodApp.id,
      committeeId: short.committeeId,
      committeeNumId: committee.committeeNumId,
      votingStart: short.votingStart,
      votingEnd: short.votingEnd,
      topicOptionLengths: clone(short.topicOptionLengths),
      numEscrows: u8(committee.escrowsVotes.length),
    }
    this.periods(key).value = clone(period)

    const shape = this.zeroedTopicShape(short.topicOptionLengths)
    this.periodVoteCache(key).value = {
      internal: clone(shape),
      ggovTotals: clone(shape),
    }

    // One box per escrow of the committee snapshot - NOT of the `escrows` box. An escrow registered
    // since the last syncCommittee has no snapshotted voting power to cast, so it gets no box until
    // the committee is re-synced. Sizing from the snapshot also avoids reading the `escrows` box,
    // which the 4096-byte stack cap would stop decoding at ~127 entries.
    for (let i: uint64 = 0; i < committee.escrowsVotes.length; i++) {
      const escrowVotes: FracEscrowVotes = { votes: clone(shape) }
      this.periodEscrowVotes([key, u8(i)]).value = clone(escrowVotes)
    }

    return period
  }

  /**
   * Log this instance's entire voting state for `periodId` in one shot: the period record, then the
   * aggregate tallies, then one line per escrow in `escrows` index order. Readonly - meant to be
   * simulated with `allowMoreLogging`, which lifts the 1024-byte-total and 32-call log caps that
   * would otherwise bound how many escrows could be dumped.
   *
   * Split one-line-per-tally rather than returned whole, for the same reason `GGovPeriod.logPeriod`
   * exists: a single ARC-4 return would overflow. Every line is safely bounded - a tally encodes to
   * `2 + topics*(4 + 4*options)` bytes, and `GGovPeriod.setReady` already refuses any period whose
   * `81 + topics*(4 + 4*options)` vote event would pass 1024, so a line can never exceed ~945 bytes.
   *
   * Escrow count comes from the period record, NOT the committee box: re-syncing the committee
   * alone can grow `escrowsVotes` past the boxes this period actually has.
   *
   * Logs nothing at all if the period has never been synced - that is how a reader detects absence.
   * @param periodId gGov period ID
   */
  @abimethod({ readonly: true })
  public logPeriodVotingState(periodId: Uint32): void {
    const periodBox = this.periods(periodId)
    if (!periodBox.exists) return
    const period = clone(periodBox.value)
    log(encodeArc4(period))
    log(encodeArc4(clone(this.periodVoteCache(periodId).value)))
    for (let i: uint64 = 0; i < period.numEscrows.asUint64(); i++) {
      log(encodeArc4(clone(this.periodEscrowVotes([periodId, u8(i)]).value)))
    }
  }

  // ── Admin: lifecycle ──────────────────────────────────────────────

  /** App updatable by the resolved admin */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.ensureCallerIsAdmin()
  }

  /** App deletable by the resolved admin */
  @baremethod({ allowActions: ['DeleteApplication'] })
  public deleteApplication(): void {
    this.ensureCallerIsAdmin()
    // TODO: delete boxes to recover their MBR. Fixed-key boxes can be deleted inline; for any
    // unbounded boxmap, add a batch delete method the SDK can page-drain before this call.
    // See GGovPeriodContract.deleteApplication() for a reference implementation.

    // Close out all escrow balance to caller
    // itxn.payment({ receiver: Txn.sender, amount: 0, closeRemainderTo: Txn.sender }).submit()
  }
}
