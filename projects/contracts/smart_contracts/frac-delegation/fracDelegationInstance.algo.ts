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
import { compileArc4, encodeArc4, Uint16, Uint32, Uint8 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import {
  errAccountAqExists,
  errAccountAqNotExists,
  errAccountNotExists,
  errAqIncomplete,
  errAqNotStarted,
  errCommitteeNotExists,
  errGGovCannotOverride,
  errGGovDelegationNoAcctRef,
  errGGovHasVotes,
  errGGovNoDelegation,
  errGGovNotReady,
  errGGovPeriodNotExists,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingEnded,
  errGGovVotingNotStarted,
  errIngestedAqNotZero,
  errNoEscrows,
  errPeriodAppMismatch,
  errRegistryMissing,
  errTotalAccountsZero,
  errTotalAqExceeded,
  errTotalAqZero,
  errTotalGovsExceeded,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import {
  AccountWithAq,
  CommitteeId,
  FracAccountAqKey,
  FracAccountCommitteeAq,
  FracCommitteeAq,
  FracCommitteeStanding,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodAccountKey,
  FracPeriodEscrowKey,
  FracPeriodVoteCache,
  FracVoteCast,
  FracVotingRecord,
  getEmptyFracCommitteeAq,
  getEmptyFracCommitteeStanding,
  getEmptyFracEscrowVotes,
  getEmptyFracInstanceCommittee,
  getEmptyFracInstancePeriod,
  getEmptyFracPeriodVoteCache,
  getEmptyFracVotingRecord,
} from '../base/types.algo'
import { u16, u32, u8 } from '../base/utils.algo'
import { GGovPeriodContract } from '../ggov-period/ggovPeriod.algo'
import { GGovRegistryContract } from '../ggov-registry/ggovRegistry.algo'
import { FracDelegationRegistryContract, fracRegistryGGovKey } from './fracDelegationRegistry.algo'

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
  /**
   * Per-[period, account] internal vote record, written by `vote`. Keyed by the frac registry's
   * numeric account ID (like `accountAq`), and holding exactly the rows the account submitted so a
   * re-vote can subtract them from the aggregate tally. The instance app account pays the box MBR,
   * pulled from the registry on demand via `checkNeedMBR`.
   */
  votingRecords = BoxMap<FracPeriodAccountKey, FracVotingRecord>({ keyPrefix: 'r' })

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
    loggedAssert(exists, errRegistryMissing)
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
      loggedAssert(exists, errRegistryMissing)
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
    loggedAssert(Txn.sender === this.resolveAdmin(), errUnauthorized)
  }

  /** Caller must match the resolved operator. */
  protected ensureCallerIsOperator(): void {
    loggedAssert(Txn.sender === this.resolveOperator(), errUnauthorized)
  }

  /**
   * gGov registry app to read committee data from, resolved from the registry's
   * `gGovRegistryApp` global state. Throws if the registry has not configured one yet.
   */
  protected resolveGGovRegistryApp(): Application {
    const [appId, exists] = op.AppGlobal.getExUint64(this.registryApp.value, fracRegistryGGovKey)
    loggedAssert(exists && appId > 0, errRegistryMissing)
    return Application(appId)
  }

  /**
   * The bound frac registry, as an `Application` for inner ABI calls. Unlike `resolveAdmin` and
   * friends - which peek at the registry's global state - `ingestAq` has to actually call it, so it
   * needs the app rather than a field out of it.
   */
  protected resolveRegistryApp(): Application {
    loggedAssert(this.registryApp.value > 0, errRegistryMissing)
    return Application(this.registryApp.value)
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
   * Its counterpart does the same - see `FracDelegationRegistry.requestMBR`.
   */
  protected checkNeedMBR(): void {
    const app = Global.currentApplicationAddress
    if (app.balance > app.minBalance) return
    compileArc4(FracDelegationRegistryContract).call.requestMBR({
      appId: this.resolveRegistryApp(),
      args: [this.instanceNumId.value],
      fee: Global.minTxnFee,
    })
  }

  /** Caller must be the configured registry application (inner app call). */
  protected ensureCallerIsRegistry(): void {
    loggedAssert(this.registryApp.value > 0, errRegistryMissing)
    loggedAssert(Global.callerApplicationId === this.registryApp.value, errUnauthorized)
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
    loggedAssert(exists, errRegistryMissing)
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

  /**
   * This instance's registered escrow accounts, in registration order, or an empty list if none has
   * been registered yet. `escrowsVotes` on each `FracInstanceCommittee` snapshot is index-synced
   * with this list. Readonly - meant to be simulated.
   *
   * Reads the whole `escrows` box onto the stack, so it is bounded by the AVM's 4096-byte stack cap
   * (~127 escrows), well above any realistic escrow count. Off-chain readers wanting the raw box
   * without that cap can still read it directly.
   */
  @abimethod({ readonly: true })
  public getEscrows(): Account[] {
    return this.escrows.exists ? clone(this.escrows.value) : ([] as Account[])
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
    loggedAssert(escrows.length > 0, errNoEscrows)

    const gGovRegistry = compileArc4(GGovRegistryContract)

    // An unknown committee returns empty metadata rather than throwing; numericId 0 is never
    // assigned by the registry, so it marks "no such committee".
    const committeeMetadata = gGovRegistry.call.getCommitteeMetadata({
      appId: gGovRegistryAppId,
      args: [committeeId, true],
    }).returnValue
    loggedAssert(committeeMetadata.numericId.asUint64() > 0, errCommitteeNotExists)

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

  /**
   * This instance's synced snapshot of gGov committee `committeeId`, or an empty record (sentinel
   * `committeeNumId` 0) if `syncCommittee` has never been run for it - mirroring
   * `GGovRegistry.getCommitteeMetadata`. `escrowsVotes` is index-synced with `getEscrows`. Readonly.
   * @param committeeId 32-byte gGov committee ID
   */
  @abimethod({ readonly: true })
  public getCommittee(committeeId: CommitteeId): FracInstanceCommittee {
    const box = this.committees(committeeId)
    if (box.exists) return box.value
    return getEmptyFracInstanceCommittee()
  }

  /**
   * Batch-log committee snapshots in input order, one line per id: the record if synced, else the
   * empty sentinel (`committeeNumId` 0). Readonly - meant to be simulated with `allowMoreLogging`.
   * Modelled on `GGovRegistry.logCommitteeMetadata`; each id is one `committees` box reference, so
   * callers supply the ids to probe.
   * @param committeeIds 32-byte gGov committee IDs
   */
  @abimethod({ readonly: true })
  public logCommittees(committeeIds: CommitteeId[]): void {
    for (const committeeId of committeeIds) {
      const box = this.committees(committeeId)
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(getEmptyFracInstanceCommittee()))
      }
    }
  }

  /**
   * This instance's headline position in gGov committee `committeeId`: the snapshot's `totalVotes`
   * joined with the AlgoQuarters ledger behind it, in one readonly call. Readonly.
   *
   * Exists so `FracDelegationRegistry.logInstanceCommittees` can tag one record per instance from a
   * single inner call. The join has to happen here: `committeeAq` is keyed by the locally-synced
   * `committeeNumId`, which is only knowable after reading `committees` - so a caller doing this
   * from outside pays two round-trips and cannot start the second until the first lands.
   *
   * Neither half is required to exist. An unsynced committee returns the all-zero record
   * (`committeeNumId` 0); a synced committee with no ledger open returns real `totalVotes` and
   * `totalAq` 0. See `FracCommitteeStanding` for the two sentinels.
   *
   * Reads the snapshot field-wise rather than whole: `escrowsVotes` sits between the two fields
   * wanted here and grows with the escrow count, and this is on the hot path of a paged logger.
   *
   * @param committeeId 32-byte gGov committee ID
   */
  @abimethod({ readonly: true })
  public getCommitteeStanding(committeeId: CommitteeId): FracCommitteeStanding {
    const committeeBox = this.committees(committeeId)
    if (!committeeBox.exists) return getEmptyFracCommitteeStanding()
    const committeeNumId = committeeBox.value.committeeNumId
    const totalVotes = committeeBox.value.totalVotes

    const aqBox = this.committeeAq(committeeNumId)
    if (!aqBox.exists) {
      return {
        committeeNumId,
        totalVotes,
        totalAq: u32(0),
        ingestedAq: u32(0),
        totalAccounts: u32(0),
        numAccounts: u32(0),
      }
    }
    const aq = clone(aqBox.value)
    return {
      committeeNumId,
      totalVotes,
      totalAq: aq.totalAq,
      ingestedAq: aq.ingestedAq,
      totalAccounts: aq.totalAccounts,
      numAccounts: aq.numAccounts,
    }
  }

  // ── AlgoQuarters ──────────────────────────────────────────────────

  /**
   * Open (or re-open) the AlgoQuarters ledger for gGov committee `committeeId`. Operator only.
   *
   * `totalAq` is the off-chain pipeline's declared AQ total for the committee's period; `ingestAq`
   * accumulates towards it and may never pass it, so a miscounted total surfaces as a failed ingest
   * rather than a silently wrong voting denominator. `totalAccounts` is the parallel declared count of
   * accounts, checked the same way - both must be reached for the ledger to count as complete, mirroring
   * the gGov registry's `totalMembers`/`totalVotes` pair.
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
   * @param totalAccounts Total number of accounts expected for the committee's period. Must be greater than zero.
   * @returns The opened ledger
   */
  public startAqIngest(committeeId: CommitteeId, totalAq: Uint32, totalAccounts: Uint32): FracCommitteeAq {
    this.ensureCallerIsOperator()
    // Must have nonzero totals. A zero total would also make the record indistinguishable from the
    // "no ledger" sentinel `getCommitteeAq` returns. Mirrors the gGov registry's totalVotes/totalMembers
    // guards.
    loggedAssert(totalAq.asUint64() > 0, errTotalAqZero)
    loggedAssert(totalAccounts.asUint64() > 0, errTotalAccountsZero)

    const committeeBox = this.committees(committeeId)
    // committee must exist locally
    loggedAssert(committeeBox.exists, errCommitteeNotExists)

    const committeeNumId = committeeBox.value.committeeNumId
    const committeeAqBox = this.committeeAq(committeeNumId)

    if (committeeAqBox.exists) {
      // Only a pristine ledger may have its total re-set. `ingestAq` rejects zero-AQ accounts, so a
      // zero `ingestedAq` also implies zero `numAccounts` - nothing is lost by rebuilding from scratch.
      loggedAssert(committeeAqBox.value.ingestedAq.asUint64() === 0, errIngestedAqNotZero)
    }

    const committeeAq: FracCommitteeAq = {
      totalAq,
      totalAccounts,
      ingestedAq: u32(0),
      numAccounts: u32(0),
    }
    committeeAqBox.value = clone(committeeAq)
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

    // ensure aq import has started
    const aqBox = this.committeeAq(committeeNumId)
    loggedAssert(aqBox.exists, errAqNotStarted)
    const committeeAq = clone(aqBox.value)

    let sumAq: uint64 = 0
    for (const accountAq of clone(accountAqs)) {
      // zero account AQ is not valid
      loggedAssert(accountAq.aq.asUint64() > 0, errZeroAq)

      // get account ID, creating it if this is the first sighting of the account
      // also associates account with this instance on the frac registry
      const registryAccount = compileArc4(FracDelegationRegistryContract).call.getOrCreateAccountWithInstance({
        appId: registryApp,
        args: [accountAq.account, this.instanceNumId.value],
      }).returnValue

      // if box exists, the account has already been ingested for this committee
      const box = this.accountAq([registryAccount.accountId, committeeNumId])
      if (box.exists) {
        log(accountAq.account.bytes)
        loggedErr(errAccountAqExists)
      }
      box.value = accountAq.aq

      sumAq += accountAq.aq.asUint64()
    }

    // tally of ingested AQ updated with this run's AQ sum
    const ingestedAq: uint64 = committeeAq.ingestedAq.asUint64() + sumAq
    // ensure we do not exceed the stated total AQ
    loggedAssert(ingestedAq <= committeeAq.totalAq.asUint64(), errTotalAqExceeded)
    // ensure we do not exceed the stated total accounts
    const nextNumAccounts: uint64 = committeeAq.numAccounts.asUint64() + accountAqs.length
    loggedAssert(nextNumAccounts <= committeeAq.totalAccounts.asUint64(), errTotalGovsExceeded)

    committeeAq.ingestedAq = u32(ingestedAq)
    committeeAq.numAccounts = u32(nextNumAccounts)
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
      loggedAssert(!mustBeComplete, errAqNotStarted)
      return getEmptyFracCommitteeAq()
    }
    const committeeAq = clone(aqBox.value)
    // The guard internal voting will need: weight is split against `totalAq`, so a half-ingested
    // ledger would hand early voters an inflated share. Same role as the `mustBeComplete` flag
    // `syncCommittee` passes into the gGov registry one level up.
    if (mustBeComplete) {
      loggedAssert(committeeAq.ingestedAq === committeeAq.totalAq, errAqIncomplete)
      loggedAssert(committeeAq.numAccounts === committeeAq.totalAccounts, errAqIncomplete)
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
   * Log each account's ingested AlgoQuarters in committee `committeeNumId`, one Uint32 line per
   * entry of `accountIds`, in input order. 0 for an account with no entry - unambiguous, since
   * `ingestAq` rejects zero-AQ accounts. Readonly - meant to be simulated with `allowMoreLogging`.
   * Batch shape like the registry's `logAccounts`: the accountAq box key puts the committee in the
   * suffix, so callers supply the account IDs to probe.
   * @param committeeNumId gGov committee numeric ID
   * @param accountIds Frac registry numeric account IDs
   */
  @abimethod({ readonly: true })
  public logAccountAqs(committeeNumId: Uint16, accountIds: Uint32[]): void {
    for (const accountId of accountIds) {
      const box = this.accountAq([accountId, committeeNumId])
      log(encodeArc4(box.exists ? box.value : u32(0)))
    }
  }

  /**
   * Bundled read of `accountId`'s AlgoQuarters standing in committee `committeeId`: the instance's
   * own identity, the committee's identity, the account's weight against the committee total, and
   * the instance's own gGov power there, in one readonly call so a caller (e.g. a wallet showing
   * "your voting weight here") needs no follow-up lookups.
   *
   * `totalVotes` comes free with the `committees` box already read to resolve `committeeNumId`, and
   * is what lets a caller price the position (`userAq / totalAq * totalVotes`) without a second,
   * per-instance read. Taken field-wise rather than by cloning the snapshot: `escrowsVotes` sits
   * between the two fields wanted here and grows with the escrow count, and this is on the hot path
   * of a paged logger. Same reasoning as `getCommitteeStanding`.
   *
   * Non-throwing: an unsynced committee resolves `committeeNumId` to 0 (never assigned by the
   * registry) with `totalVotes` 0, and `userAq`/`totalAq` then read from the sentinel numeric ID, so
   * both come back 0 too. `committeeId` echoes the input regardless.
   * @param accountId Frac registry numeric account ID
   * @param committeeId 32-byte gGov committee ID
   */
  @abimethod({ readonly: true })
  public getAccountCommitteeAq(accountId: Uint32, committeeId: CommitteeId): FracAccountCommitteeAq {
    const committeeBox = this.committees(committeeId)
    const committeeExists = committeeBox.exists
    const committeeNumId = committeeExists ? committeeBox.value.committeeNumId : u16(0)
    const totalVotes = committeeExists ? committeeBox.value.totalVotes : u32(0)

    const aqBox = this.committeeAq(committeeNumId)
    const totalAq = aqBox.exists ? aqBox.value.totalAq : u32(0)

    const accountAqBox = this.accountAq([accountId, committeeNumId])
    const userAq = accountAqBox.exists ? accountAqBox.value : u32(0)

    return {
      instanceNumId: this.instanceNumId.value,
      instanceAppId: Global.currentApplicationId.id,
      committeeNumId,
      committeeId,
      instanceName: this.name.value,
      userAq,
      totalAq,
      totalVotes,
    }
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
   * NOTE: internal voting (`vote`) now reads AQ, so this still needs a guard refusing to drain a
   * committee any period has live votes against (mirroring `syncPeriod`'s `cacheHasVotes`) -
   * removing an account's weight after it voted would corrupt the tally denominator. Until that
   * guard lands, operators must not uningest a committee with an open, voted-on period.
   * @param committeeNumId gGov committee numeric ID
   * @param accounts Accounts to remove. Any order; no duplicates.
   */
  public uningestAq(committeeNumId: Uint16, accounts: Account[]): void {
    this.ensureCallerIsOperator()
    const registryApp = this.resolveRegistryApp()

    const aqBox = this.committeeAq(committeeNumId)
    loggedAssert(aqBox.exists, errAqNotStarted)
    const committeeAq = clone(aqBox.value)

    let removedAq: uint64 = 0
    for (const account of clone(accounts)) {
      const registryAccount = compileArc4(FracDelegationRegistryContract).call.getAccount({
        appId: registryApp,
        args: [account],
      }).returnValue

      const box = this.accountAq([registryAccount.accountId, committeeNumId])
      if (!box.exists) {
        log(account.bytes)
        loggedErr(errAccountAqNotExists)
      }
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
    loggedAssert(hasPeriodId, errGGovPeriodNotExists)
    const [ready, _hasReady] = op.AppGlobal.getExUint64(periodApp, Bytes`ready`)
    loggedAssert(ready > 0, errGGovNotReady)

    const short = compileArc4(GGovPeriodContract).call.getPeriodShort({ appId: periodApp }).returnValue

    const committeeBox = this.committees(short.committeeId)
    loggedAssert(committeeBox.exists, errCommitteeNotExists)
    const committee = clone(committeeBox.value)

    const key = u32(periodId)

    // A pristine cache may be rebuilt; one holding votes may not. Rebinding a period ID to a
    // different app is never valid, so reject it rather than silently repointing the record.
    if (this.periodVoteCache(key).exists) {
      loggedAssert(this.periods(key).value.periodAppId === periodApp.id, errPeriodAppMismatch)
      loggedAssert(!this.cacheHasVotes(key), errGGovHasVotes)
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
   * This instance's synced snapshot of gGov period `periodId`, or an empty record (sentinel
   * `periodAppId` 0) if `syncPeriod` has never been run for it. Readonly.
   * @param periodId gGov period ID
   */
  @abimethod({ readonly: true })
  public getPeriod(periodId: Uint32): FracInstancePeriod {
    const box = this.periods(periodId)
    if (box.exists) return box.value
    return getEmptyFracInstancePeriod()
  }

  /**
   * Batch-log period snapshots in input order, one line per id: the record if synced, else the empty
   * sentinel (`periodAppId` 0). Readonly - meant to be simulated with `allowMoreLogging`. Modelled
   * on `GGovRegistry.logPeriodSummaries`; each id is one `periods` box reference.
   * @param periodIds gGov period IDs
   */
  @abimethod({ readonly: true })
  public logPeriods(periodIds: Uint32[]): void {
    for (const periodId of periodIds) {
      const box = this.periods(periodId)
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(getEmptyFracInstancePeriod()))
      }
    }
  }

  // ── Voting ────────────────────────────────────────────────────────

  /** `escrows[index]`, read straight out of the box: 2-byte ARC-4 length prefix, 32 bytes each. */
  private escrowAt(index: uint64): Account {
    return Account(op.Box.extract(Bytes`escrows`, 2 + index * 32, 32))
  }

  /**
   * Internal vote on gGov period `periodId`, open to any account with ingested AlgoQuarters in the
   * period's committee, cast either by that account or by its delegatee.
   *
   * The vote is tallied into `periodVoteCache.internal` in AlgoQuarters, then mapped onto the
   * committee's total escrow gGov power against the `totalAq` denominator - so AQ that never votes
   * implicitly counts for each topic's LAST option, which by operator convention must be Abstain.
   * Whenever that mapping moves, the delta is cast externally: the target is spread across the
   * escrows greedily (options consume escrow capacity in escrow order, so every escrow row sums to
   * its full power, as `GGovPeriod.vote` requires) and each escrow whose rows changed re-votes via
   * an inner call. gGov demands an account's full power on every topic, so the first internal vote -
   * however small - casts ALL escrows on ALL topics, mostly onto Abstain; that also makes the gGov
   * tallies non-zero, which permanently locks the period app against `setReady(false)`/`editPeriod`.
   *
   * `ready`, the voting window and the committee binding are re-read live off the period app rather
   * than trusted from the `syncPeriod` snapshot: until our first cast lands, the period app's gGov
   * tallies are still all zero, so its operator could still un-ready and edit it out from under the
   * snapshot.
   *
   * User delegation mirrors `GGovPeriod.vote` and shares its source of truth: when `Txn.sender` is
   * not `voterAccount`, the gGov registry must name the sender as the voter's delegatee
   * (`getDelegate`), and the voter must be referenced at `Txn.accounts(1)` so delegated votes are
   * visible to indexers. Frac-only users (AQ holders with no gGov committee membership) can set
   * that delegation because the gGov registry's `set_voting_account` accepts frac accounts too.
   *
   * Re-votes overwrite: the account's previous rows are subtracted from the tally before the new
   * ones are added, mirroring `GGovPeriod.vote` - including its override guard, so a delegatee can
   * never overwrite a vote the owner cast directly (`errGGovCannotOverride`). Escrows must be gGov
   * accounts that delegated to this instance's app address and must NEVER vote directly - a direct
   * vote is unoverridable in the same way and would brick external casting for the period.
   *
   * Vote record MBR is paid by the instance app account on an account's first vote. A top-up is
   * requested from the registry via inner call when needed; see the `checkNeedMBR` post-condition.
   * Fees for the other inner calls come from the outer group's pool; the MBR ones are the exception
   * and pay their own, so the voter's group fee does not depend on whether the top-up fires.
   * @param voterAccount The account whose AlgoQuarters are being voted. Either `Txn.sender` itself
   *   or an account that has delegated to `Txn.sender` on the gGov registry.
   * @param periodId gGov period ID, as synced by `syncPeriod`
   * @param topicVotes [topic][option] AlgoQuarters, parallel to the period's topics/options. Every
   *   topic's row must sum to the voter's full `accountAq` weight; abstain explicitly via the last
   *   option.
   */
  public vote(voterAccount: Account, periodId: Uint32, topicVotes: Uint32[][]): void {
    // TODO split out math-heavy sections into subroutines;
    // test them independently with algo-ts-testing
    const periodBox = this.periods(periodId)
    loggedAssert(periodBox.exists, errGGovPeriodNotExists)
    const period = clone(periodBox.value)

    // Live period-app state, cheapest gates first (no inner call - getEx* like resolveAdmin).
    const [ready, _hasReady] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`ready`)
    loggedAssert(ready > 0, errGGovNotReady)
    const [votingStart, _hasStart] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`votingStart`)
    loggedAssert(Global.latestTimestamp >= votingStart, errGGovVotingNotStarted)
    const [votingEnd, _hasEnd] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`votingEnd`)
    loggedAssert(Global.latestTimestamp < votingEnd, errGGovVotingEnded)
    const [liveCommitteeId, _hasCommittee] = op.AppGlobal.getExBytes(period.periodAppId, Bytes`committeeId`)
    loggedAssert(liveCommitteeId === period.committeeId.bytes, errPeriodAppMismatch)

    // The AQ ledger must be complete: weight is split against totalAq, so a half-ingested ledger
    // would hand early voters an inflated share (see getCommitteeAq).
    const aqBox = this.committeeAq(period.committeeNumId)
    loggedAssert(aqBox.exists, errAqNotStarted)
    loggedAssert(aqBox.value.ingestedAq === aqBox.value.totalAq, errAqIncomplete)
    const totalAq: uint64 = aqBox.value.totalAq.asUint64()

    // Delegation check (inner-call the gGov registry), a direct port of GGovPeriod.vote: the gGov
    // registry is the single source of truth for user delegations in both systems.
    let isDelegated = false
    if (Txn.sender !== voterAccount) {
      const expectedDelegatee = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: this.resolveGGovRegistryApp(),
        args: [voterAccount],
      }).returnValue
      loggedAssert(expectedDelegatee === Txn.sender, errGGovNoDelegation)
      // Keep the delegator in the foreign-accounts array so delegated voting can be "seen" in
      // indexers, explorers, etc. Index 0 is the sender, so the first foreign account is accounts(1).
      loggedAssert(Txn.numAccounts > 0 && Txn.accounts(1) === voterAccount, errGGovDelegationNoAcctRef)
      isDelegated = true
    }

    // Resolve the voter's weight: readonly registry resolve, then one O(1) box read.
    const registryAccount = compileArc4(FracDelegationRegistryContract).call.getAccount({
      appId: this.resolveRegistryApp(),
      args: [voterAccount],
    }).returnValue
    loggedAssert(registryAccount.accountId.asUint64() > 0, errAccountNotExists)
    const accountAqBox = this.accountAq([registryAccount.accountId, period.committeeNumId])
    loggedAssert(accountAqBox.exists, errAccountAqNotExists)
    const userAq: uint64 = accountAqBox.value.asUint64()

    const cache = clone(this.periodVoteCache(periodId).value)
    const newVotes = clone(topicVotes)
    loggedAssert(newVotes.length === cache.internal.length, errGGovVoteMismatch)

    // Re-vote: subtract the previous rows from the tally before adding the new ones. Underflow-safe
    // by construction - every stored row was added by the vote that wrote it.
    const userVoteRecordBox = this.votingRecords([periodId, registryAccount.accountId])
    const isRevote = userVoteRecordBox.exists
    if (isRevote) {
      const existing = clone(userVoteRecordBox.value)
      // A record the owner cast directly is final as far as a delegatee is concerned
      if (isDelegated && !existing.isDelegated) {
        loggedErr(errGGovCannotOverride)
      }
      for (let t: uint64 = 0; t < existing.topicVotes.length; t++) {
        const oldRow = clone(existing.topicVotes[t])
        const tally = clone(cache.internal[t])
        const next: Uint32[] = []
        for (let o: uint64 = 0; o < oldRow.length; o++) {
          next.push(u32(tally[o].asUint64() - oldRow[o].asUint64()))
        }
        cache.internal[t] = clone(next)
      }
    }

    // Validate and tally in one pass, as GGovPeriod.vote does. Every topic's row must spend the
    // voter's exact full weight - that cap is also what bounds each tally cell by totalAq, keeping
    // the mapping's u32*u32 product inside uint64 and its last-option remainder non-negative.
    for (let t: uint64 = 0; t < newVotes.length; t++) {
      const row = clone(newVotes[t])
      const tally = clone(cache.internal[t])
      loggedAssert(row.length === tally.length, errGGovVoteMismatch)
      let rowSum: uint64 = 0
      const next: Uint32[] = []
      for (let o: uint64 = 0; o < row.length; o++) {
        next.push(u32(tally[o].asUint64() + row[o].asUint64()))
        rowSum += row[o].asUint64()
      }
      loggedAssert(rowSum === userAq, errGGovVotePowerMismatch)
      cache.internal[t] = clone(next)
    }

    // Map the internal tally onto the committee's escrow power. Powers come from the first
    // numEscrows snapshot entries and their sum - NOT committee.totalVotes, which a mid-period
    // syncCommittee may have grown past the escrow boxes this period actually has.
    const committee = clone(this.committees(period.committeeId).value)
    const numEscrows: uint64 = period.numEscrows.asUint64()
    let totalVotes: uint64 = 0
    for (let i: uint64 = 0; i < numEscrows; i++) {
      totalVotes += committee.escrowsVotes[i].asUint64()
    }

    // Non-last options floor-divide; the last option takes the remainder, folding together its own
    // mapped share, all AQ that never voted, and the rounding dust.
    const ggovVotes: Uint32[][] = []
    let ggovChanged = false
    for (let t: uint64 = 0; t < cache.internal.length; t++) {
      const tally = clone(cache.internal[t])
      const cachedRow = clone(cache.ggovTotals[t])
      const row: Uint32[] = []
      let allocated: uint64 = 0
      for (let o: uint64 = 0; o < tally.length; o++) {
        let mapped: uint64
        if (o === tally.length - 1) {
          mapped = totalVotes - allocated
        } else {
          mapped = (tally[o].asUint64() * totalVotes) / totalAq
          allocated += mapped
        }
        row.push(u32(mapped))
        if (mapped !== cachedRow[o].asUint64()) ggovChanged = true
      }
      ggovVotes.push(clone(row))
    }

    if (ggovChanged) {
      // Spread the target across escrows: per topic, options consume escrow capacity in escrow
      // order. Computed per escrow as the overlap of its cumulative power range with each option's
      // cumulative demand range - exact packing, no division, every row sums to the escrow's power.
      let escrowStart: uint64 = 0
      for (let i: uint64 = 0; i < numEscrows; i++) {
        const power: uint64 = committee.escrowsVotes[i].asUint64()
        // A powerless escrow owns an empty range: its rows are all zero, matching its zero-filled
        // box, so there is never anything to cast for it.
        if (power === 0) continue
        const escrowEnd: uint64 = escrowStart + power
        const escrowBox = this.periodEscrowVotes([periodId, u8(i)])
        const cachedVotes = clone(escrowBox.value.votes)
        const rows: Uint32[][] = []
        let escrowChanged = false
        for (let t: uint64 = 0; t < ggovVotes.length; t++) {
          const demand = clone(ggovVotes[t])
          const cachedRow = clone(cachedVotes[t])
          const row: Uint32[] = []
          let optStart: uint64 = 0
          for (let o: uint64 = 0; o < demand.length; o++) {
            const optEnd: uint64 = optStart + demand[o].asUint64()
            const lo: uint64 = optStart > escrowStart ? optStart : escrowStart
            const hi: uint64 = optEnd < escrowEnd ? optEnd : escrowEnd
            const overlap: uint64 = hi > lo ? hi - lo : 0
            row.push(u32(overlap))
            if (overlap !== cachedRow[o].asUint64()) escrowChanged = true
            optStart = optEnd
          }
          rows.push(clone(row))
        }
        if (escrowChanged) {
          // Delegated external vote: the escrow is the voter, this app account the delegatee.
          // GGovPeriod.vote requires the voter at the inner call's Txn.accounts(1).
          const escrow = this.escrowAt(i)
          compileArc4(GGovPeriodContract).call.vote({
            appId: Application(period.periodAppId),
            args: [escrow, clone(rows)],
            accounts: [escrow],
          })
          escrowBox.value = { votes: clone(rows) }
        }
        escrowStart = escrowEnd
      }
      cache.ggovTotals = clone(ggovVotes)
    }

    emit<FracVoteCast>({
      voter: voterAccount,
      sender: Txn.sender,
      accountId: registryAccount.accountId,
      userAq: u32(userAq),
      updateVote: isRevote,
      topicVotes: clone(newVotes),
    })

    userVoteRecordBox.value = { isDelegated, topicVotes: clone(newVotes) }
    this.periodVoteCache(periodId).value = clone(cache)
    // Must stay after the vote record write
    this.checkNeedMBR()
  }

  /**
   * Whether `senderAccount` may cast `voterAccount`'s internal vote on gGov period `periodId`, and
   * the AlgoQuarters weight it would carry. Readonly, non-throwing mirror of `vote`'s gates - the
   * counterpart of `GGovPeriod.canVote`, and like it, returns `[false, 0]` for every rejection
   * rather than distinguishing them.
   *
   * Covers the same ground as `vote`: the period must be synced here and live-ready on the gGov side
   * within its window, the committee's AQ ledger must be complete, the voter must be a frac account
   * with non-zero AlgoQuarters, and - when the sender is not the voter - the gGov registry must name
   * the sender as the voter's delegatee AND the voter must not already have cast a direct vote
   * (`vote`'s override guard). It does NOT check the group-level `Txn.accounts(1)` reference, which
   * is a property of the submitted transaction rather than of eligibility.
   * @param voterAccount The account whose AlgoQuarters would be voted
   * @param senderAccount The account that would submit the call
   * @param periodId gGov period ID
   */
  @abimethod({ readonly: true })
  public canVote(voterAccount: Account, senderAccount: Account, periodId: Uint32): [boolean, uint64] {
    const periodBox = this.periods(periodId)
    if (!periodBox.exists) return [false, 0]
    const period = clone(periodBox.value)

    // Live period-app state, exactly as vote() reads it (getEx*, no inner call).
    const [ready, _hasReady] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`ready`)
    if (ready === 0) return [false, 0]
    const [votingStart, _hasStart] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`votingStart`)
    if (Global.latestTimestamp < votingStart) return [false, 0]
    const [votingEnd, _hasEnd] = op.AppGlobal.getExUint64(period.periodAppId, Bytes`votingEnd`)
    if (Global.latestTimestamp >= votingEnd) return [false, 0]
    const [liveCommitteeId, _hasCommittee] = op.AppGlobal.getExBytes(period.periodAppId, Bytes`committeeId`)
    if (liveCommitteeId !== period.committeeId.bytes) return [false, 0]

    const aqBox = this.committeeAq(period.committeeNumId)
    // return false if the ledger is incomplete or the committee has no ingested accounts
    if (
      !aqBox.exists ||
      aqBox.value.ingestedAq !== aqBox.value.totalAq ||
      aqBox.value.numAccounts !== aqBox.value.totalAccounts
    )
      return [false, 0]

    const isDelegated = senderAccount !== voterAccount
    if (isDelegated) {
      const delegate = compileArc4(GGovRegistryContract).call.getDelegate({
        appId: this.resolveGGovRegistryApp(),
        args: [voterAccount],
      }).returnValue
      if (delegate === Global.zeroAddress) return [false, 0]
      if (delegate !== senderAccount) return [false, 0]
    }

    const registryAccount = compileArc4(FracDelegationRegistryContract).call.getAccount({
      appId: this.resolveRegistryApp(),
      args: [voterAccount],
    }).returnValue
    if (registryAccount.accountId.asUint64() === 0) return [false, 0]

    // Mirror vote()'s override guard so canVote agrees with what vote() will enforce.
    if (isDelegated) {
      const recordBox = this.votingRecords([periodId, registryAccount.accountId])
      if (recordBox.exists && !recordBox.value.isDelegated) return [false, 0]
    }

    const accountAqBox = this.accountAq([registryAccount.accountId, period.committeeNumId])
    if (!accountAqBox.exists) return [false, 0]
    const userAq: uint64 = accountAqBox.value.asUint64()
    if (userAq === 0) return [false, 0] // shouldn't happen, but guard against it anyway
    return [true, userAq]
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

  /**
   * This instance's aggregate vote tallies for gGov period `periodId` ([topic][option], both
   * `internal` and `ggovTotals`), or an empty record (empty top-level arrays) if `syncPeriod` has
   * never been run for it. Readonly. For the whole voting state in one shot, prefer
   * `logPeriodVotingState`.
   * @param periodId gGov period ID
   */
  @abimethod({ readonly: true })
  public getPeriodVoteCache(periodId: Uint32): FracPeriodVoteCache {
    const box = this.periodVoteCache(periodId)
    if (box.exists) return box.value
    return getEmptyFracPeriodVoteCache()
  }

  /**
   * One escrow's external gGov votes for gGov period `periodId` ([topic][option]), or an empty
   * record (empty `votes`) if that escrow has no box for the period. `escrowIndex` is the index into
   * `getEscrows`. Readonly.
   * @param periodId gGov period ID
   * @param escrowIndex Index into the `escrows` list
   */
  @abimethod({ readonly: true })
  public getPeriodEscrowVotes(periodId: Uint32, escrowIndex: Uint8): FracEscrowVotes {
    const box = this.periodEscrowVotes([periodId, escrowIndex])
    if (box.exists) return box.value
    return getEmptyFracEscrowVotes()
  }

  /**
   * `accountId`'s internal vote record for gGov period `periodId` ([topic][option] AlgoQuarters,
   * exactly as submitted), or an empty record (empty `topicVotes`) if it has not voted. `accountId`
   * is the frac registry numeric ID. Readonly.
   * @param periodId gGov period ID
   * @param accountId Frac registry numeric account ID
   */
  @abimethod({ readonly: true })
  public getVotingRecord(periodId: Uint32, accountId: Uint32): FracVotingRecord {
    const box = this.votingRecords([periodId, accountId])
    if (box.exists) return box.value
    return getEmptyFracVotingRecord()
  }

  /**
   * Batch-log several accounts' vote records for gGov period `periodId`, one line per entry of
   * `accountIds` in input order: the record if the account voted, else the empty sentinel (empty
   * `topicVotes`). Readonly - meant to be simulated with `allowMoreLogging`.
   *
   * The plural sibling of `getVotingRecord`, and what `logAccountAqs` is to `tryGetAccountAq`: each
   * id is one `votingRecords` box reference, so callers supply the ids to probe.
   *
   * What bounds a call here is the log cap rather than references, unlike its siblings:
   * `allowMoreLogging` lifts the total to 65,536 bytes, and a row cannot exceed ~950 bytes for the
   * reason given on `logPeriodVotingState` - `GGovPeriod.setReady` refuses any period whose vote
   * event would pass 1024. So the SDK's usual 63 ids per call fits with room to spare, arriving at
   * the same number as `logCommittees` for an unrelated reason (there it is the 2048-byte app-arg
   * cap).
   *
   * @param periodId gGov period ID
   * @param accountIds Frac registry numeric account IDs
   */
  @abimethod({ readonly: true })
  public logVotingRecords(periodId: Uint32, accountIds: Uint32[]): void {
    for (const accountId of accountIds) {
      const box = this.votingRecords([periodId, accountId])
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(getEmptyFracVotingRecord()))
      }
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
