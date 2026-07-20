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
  errAccountAqExists,
  errAccountNotExists,
  errAqIncomplete,
  errAqNotStarted,
  errCommitteeNotExists,
  errGGovHasVotes,
  errGGovNotReady,
  errGGovPeriodNotExists,
  errIngestedAqNotZero,
  errNoEscrows,
  errPeriodAppMismatch,
  errRegistryMissing,
  errTotalAqExceeded,
  errTotalAqZero,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import {
  AccountWithAq,
  CommitteeId,
  FracAccountAqKey,
  FracCommitteeAq,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodEscrowKey,
  FracPeriodVoteCache,
  getEmptyFracCommitteeAq,
} from '../base/types.algo'
import { ensure, ensureExtra, u32, u8 } from '../base/utils.algo'
import { GGovPeriodContract } from '../ggov-period/ggovPeriod.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'
import { FracDelegationRegistryContract } from './fracDelegationRegistry.algo'

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
  /**
   * Per-committee AlgoQuarters ledger, opened by `startAqIngest` and accumulated by `ingestAq`.
   * Keyed by the committee's gGov numeric ID as recorded in the `committees` snapshot, NOT by the
   * 32-byte committee ID: `ingestAq` then needs neither a 32-byte argument nor a `committees` box
   * reference, and a reference slot is the scarcest thing that call has.
   */
  committeeAq = BoxMap<Uint16, FracCommitteeAq>({ keyPrefix: 'A' })
  /**
   * Per-[account, committee] ingested AlgoQuarters, written by `ingestAq`. Keyed by the frac
   * registry's numeric account ID, which is what makes an account's own weight a single O(1) box
   * read at internal-vote time - the reason this is a BoxMap and not a packed superbox like the gGov
   * registry's committee members, which can only be read back via an offset hint.
   */
  accountAq = BoxMap<FracAccountAqKey, Uint32>({ keyPrefix: 'q' })

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

  /**
   * The bound frac registry, as an `Application` for inner ABI calls. Unlike `resolveAdmin` and
   * friends - which peek at the registry's global state - `ingestAq` has to actually call it, so it
   * needs the app rather than a field out of it.
   */
  protected resolveRegistryApp(): Application {
    ensure(this.registryApp.value > 0, errRegistryMissing)
    return Application(this.registryApp.value)
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

  // ── AlgoQuarters ──────────────────────────────────────────────────

  /**
   * Open (or re-open) the AlgoQuarters ledger for gGov committee `committeeId`. Operator only.
   *
   * `totalAq` is the off-chain pipeline's declared AQ total for the committee's period; `ingestAq`
   * accumulates towards it and may never pass it, so a miscounted total surfaces as a failed ingest
   * rather than a silently wrong voting denominator.
   *
   * Requires the committee to be synced locally (`syncCommittee`). That snapshot supplies the
   * `committeeNumId` every later call keys by, and it is the only thing binding this ledger to a real
   * gGov committee - `syncCommittee` reads the committee with `mustBeComplete`, so a ledger can never
   * be opened against a half-ingested member set.
   *
   * Re-runnable, but only while the ledger is pristine: once any AQ have been ingested the total is
   * frozen, because moving it would silently redefine completeness under the accounts already
   * written. There is no un-ingest path yet, so a ledger filled against a bad total cannot currently
   * be reset.
   * @param committeeId 32-byte gGov committee ID, as synced by `syncCommittee`
   * @param totalAq Total AlgoQuarters for the committee's period. Must be greater than zero.
   * @returns The opened ledger
   */
  public startAqIngest(committeeId: CommitteeId, totalAq: Uint32): FracCommitteeAq {
    this.ensureCallerIsOperator()
    // Cheapest check first. A zero total would also make the record indistinguishable from the
    // "no ledger" sentinel `getCommitteeAq` returns.
    ensure(totalAq.asUint64() > 0, errTotalAqZero)

    const committeeBox = this.committees(committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    // Head field at offset 0 - read directly rather than cloning the whole record, whose
    // escrowsVotes array is irrelevant here.
    const committeeNumId = committeeBox.value.committeeNumId

    const aqBox = this.committeeAq(committeeNumId)
    // Only a pristine ledger may have its total re-set. `ingestAq` rejects zero-AQ accounts, so a
    // zero `ingestedAq` also implies zero `numAccounts` - nothing is lost by rebuilding from scratch.
    if (aqBox.exists) {
      ensure(aqBox.value.ingestedAq.asUint64() === 0, errIngestedAqNotZero)
    }

    const committeeAq: FracCommitteeAq = {
      totalAq,
      ingestedAq: u32(0),
      numAccounts: u32(0),
    }
    aqBox.value = clone(committeeAq)
    return committeeAq
  }

  /**
   * Ingest a batch of accounts' AlgoQuarters into committee `committeeNumId`'s ledger. Operator only.
   *
   * Each account is resolved to its frac-registry numeric ID by an inner call to the registry's
   * `getOrCreateAccountWithInstance`, which mints an ID on first sight and associates the account
   * with this instance. That is one inner call per account - which is why no account-ID hint is
   * needed, and why an account that exists but was never linked here gets linked as a side effect.
   * Costly in fees (the SDK must cover them via `extraFee`), but every inner app call adds 700 to the
   * group's opcode pool, so the loop largely pays for its own execution.
   *
   * Append-only per account: an account already ingested for this committee is rejected rather than
   * overwritten, so a replayed batch fails loudly instead of double-counting `ingestedAq`. Batches
   * are otherwise unordered and independent - unlike the gGov registry's packed superbox this is a
   * BoxMap, so there is no offset to maintain and no ascending-account-ID rule to honour.
   *
   * The instance app account pays ~6,900 microALGO of box MBR per account, and the REGISTRY app
   * account pays ~19,700 microALGO for every account it has never seen before. Keep both funded:
   * there is no funding path from here, the group fails atomically if either is short, and an
   * underfunded registry also breaks the client-side simulate that populates box references.
   * @param committeeNumId gGov committee numeric ID, from `startAqIngest`
   * @param accountAqs Accounts and their AlgoQuarters. Any order; no duplicates within or across batches.
   */
  public ingestAq(committeeNumId: Uint16, accountAqs: AccountWithAq[]): void {
    this.ensureCallerIsOperator()
    const registryApp = this.resolveRegistryApp()

    // Checked before the first inner call, so the most likely operator mistake (a wrong
    // committeeNumId) fails for free rather than after minting account IDs for the whole batch.
    const aqBox = this.committeeAq(committeeNumId)
    ensure(aqBox.exists, errAqNotStarted)
    const committeeAq = clone(aqBox.value)

    let sumAq: uint64 = 0
    for (const accountAq of clone(accountAqs)) {
      // Rejected before this account's inner call, mirroring the gGov registry's zero-vote guard: a
      // zero-AQ account carries no weight, would still cost a box's MBR, and the pipeline already
      // floors sub-1-AQ accounts out of its output - so a zero here means bad input.
      ensure(accountAq.aq.asUint64() > 0, errZeroAq)

      // Inlined, NOT hoisted into a `const` above the loop: the frac registry compiles this
      // instance (createInstance), so hoisting materialises its whole program here and puya rejects
      // the cycle. Called inline against an explicit appId, only the method selector is needed and
      // no program reference is created - the same shape `GGovPeriod` uses to call back into the
      // gGov registry, which is cyclical in exactly the same way.
      const registryAccount = compileArc4(FracDelegationRegistryContract).call.getOrCreateAccountWithInstance({
        appId: registryApp,
        args: [accountAq.account, this.instanceNumId.value],
      }).returnValue

      // Only checkable after the inner call - the account ID is what the box is keyed by. Logs the
      // offending address, as `uningestGovs` does, so one bad row in a batch of dozens is findable.
      const box = this.accountAq([registryAccount.accountId, committeeNumId])
      ensureExtra(!box.exists, errAccountAqExists, accountAq.account.bytes)
      box.value = accountAq.aq

      sumAq += accountAq.aq.asUint64()
    }

    // Accumulated in uint64 and bounded before narrowing, exactly as `ingestGovs` does: `totalAq` is
    // itself a Uint32, so any sum passing this check is by construction safe to `u32()`.
    const ingestedAq: uint64 = committeeAq.ingestedAq.asUint64() + sumAq
    ensure(ingestedAq <= committeeAq.totalAq.asUint64(), errTotalAqExceeded)

    committeeAq.ingestedAq = u32(ingestedAq)
    committeeAq.numAccounts = u32(committeeAq.numAccounts.asUint64() + accountAqs.length)
    aqBox.value = clone(committeeAq)
  }

  /**
   * This instance's AlgoQuarters ledger for committee `committeeNumId`, or an empty record if
   * `startAqIngest` never opened one - `totalAq` 0 is the "no ledger" sentinel, since a real ledger
   * always has a non-zero total. Mirrors `GGovRegistry.getCommitteeMetadata`, sentinel and all.
   * @param committeeNumId gGov committee numeric ID
   * @param mustBeComplete Whether to require that every declared AlgoQuarter has been ingested
   */
  @abimethod({ readonly: true })
  public getCommitteeAq(committeeNumId: Uint16, mustBeComplete: boolean): FracCommitteeAq {
    const aqBox = this.committeeAq(committeeNumId)
    if (!aqBox.exists) {
      ensure(!mustBeComplete, errAqNotStarted)
      return getEmptyFracCommitteeAq()
    }
    const committeeAq = clone(aqBox.value)
    // The guard internal voting will need: weight is split against `totalAq`, so a half-ingested
    // ledger would hand early voters an inflated share. Same role as the `mustBeComplete` flag
    // `syncCommittee` passes into the gGov registry one level up.
    if (mustBeComplete) {
      ensure(committeeAq.ingestedAq === committeeAq.totalAq, errAqIncomplete)
    }
    return committeeAq
  }

  /**
   * `accountId`'s ingested AlgoQuarters in committee `committeeNumId`, or 0 if it has none.
   * Non-throwing, like the gGov registry's `tryGetGovVotingPower`: an account with no AlgoQuarters
   * simply has no weight, which is not an error at the point of asking.
   * @param accountId Frac registry numeric account ID
   * @param committeeNumId gGov committee numeric ID
   */
  @abimethod({ readonly: true })
  public tryGetAccountAq(accountId: Uint32, committeeNumId: Uint16): Uint32 {
    const box = this.accountAq([accountId, committeeNumId])
    if (!box.exists) return u32(0)
    return box.value
  }

  /**
   * Remove accounts' AlgoQuarters from committee `committeeNumId`'s ledger. Operator only.
   *
   * The correction-and-lifecycle counterpart to `ingestAq`: it walks back a batch ingested from bad
   * pipeline output, and - because a committee is per-period and each period opens a fresh ledger -
   * it is how a settled committee's ~6,900 microALGO-per-account box MBR is handed back. Deleting the
   * boxes lowers the instance app account's minimum balance; recover the freed ALGO with `withdrawALGO`.
   *
   * Each address is resolved to its frac-registry account ID by an inner call to the registry's
   * readonly `getAccount` - a read, NOT get-or-create: an unregistered account resolves to ID 0,
   * whose box never exists, so it is rejected as "not ingested" rather than minting anything.
   *
   * Append-only in reverse: an account with no box for this committee is rejected, so a duplicate
   * within a batch fails on its second pass (its box is already gone) and a replayed batch fails
   * whole. Order-independent - a BoxMap deletes by key, with none of `uningestGovs`' descending rule.
   *
   * Draining a ledger all the way to `ingestedAq === 0` re-opens it for a fresh `startAqIngest`.
   *
   * Deliberately does NOT touch the registry: account IDs are permanent and the account -> instance
   * association `ingestAq` created stays true (the account may hold AlgoQuarters in this instance's
   * other committees). The registry's per-instance `numAccounts` therefore counts accounts ever
   * associated with the instance, not accounts currently ingested.
   *
   * NOTE: once internal voting exists, this will need a guard refusing to drain a committee any
   * period has live votes against (mirroring `syncPeriod`'s `cacheHasVotes`) - removing an account's
   * weight after it voted would corrupt the tally denominator. Nothing reads AQ during voting yet.
   * @param committeeNumId gGov committee numeric ID
   * @param accounts Accounts to remove. Any order; no duplicates.
   */
  public uningestAq(committeeNumId: Uint16, accounts: Account[]): void {
    this.ensureCallerIsOperator()
    const registryApp = this.resolveRegistryApp()

    const aqBox = this.committeeAq(committeeNumId)
    ensure(aqBox.exists, errAqNotStarted)
    const committeeAq = clone(aqBox.value)

    let removedAq: uint64 = 0
    for (const account of clone(accounts)) {
      const registryAccount = compileArc4(FracDelegationRegistryContract).call.getAccount({
        appId: registryApp,
        args: [account],
      }).returnValue

      const box = this.accountAq([registryAccount.accountId, committeeNumId])
      ensureExtra(box.exists, errAccountNotExists, account.bytes)
      removedAq += box.value.asUint64()
      box.delete()
    }

    // Both subtractions are underflow-safe by construction: every removed box's AQ was added to
    // ingestedAq and counted in numAccounts by the ingestAq that wrote it (and the AVM rejects an
    // underflow regardless). numAccounts uses accounts.length because each removed box is distinct -
    // a repeat fails the box.exists check above before reaching here.
    committeeAq.ingestedAq = u32(committeeAq.ingestedAq.asUint64() - removedAq)
    committeeAq.numAccounts = u32(committeeAq.numAccounts.asUint64() - accounts.length)
    aqBox.value = clone(committeeAq)
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
