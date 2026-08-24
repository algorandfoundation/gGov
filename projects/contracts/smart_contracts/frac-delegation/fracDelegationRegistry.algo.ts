import {
  Account,
  Application,
  baremethod,
  Box,
  BoxMap,
  Bytes,
  bytes,
  clone,
  compile,
  contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  log,
  loggedAssert,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  compileArc4,
  encodeArc4,
  methodSelector,
  Uint16,
  Uint32,
} from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import {
  errEscrowAssigned,
  errInstanceAppNotConfigured,
  errInstanceAppNotExists,
  errInstanceNameTooLong,
  errUnauthorized,
} from '../base/errors.algo'
import {
  CommitteeId,
  FracAccountVotingRecord,
  FracEscrowInstance,
  FracInstance,
  FracInstanceCommitteeStanding,
  FracRegAccount,
} from '../base/types.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'

export const fracRegistryGGovKey = Bytes`gGovRegistryApp`

/**
 * Longest instance name `createInstance` accepts, in UTF-8 bytes.
 *
 * The name rides along in every `FracInstanceCommitteeStanding`, and `logInstanceCommittees` emits
 * one of those per instance as a single AVM log - which the VM caps at 1024 bytes. The record's
 * fixed head is 42 bytes plus the string's 2-byte length prefix, so an unbounded name could push a
 * page past that cap and fail the *whole* page, taking every pooled-voting read of this registry
 * down with it. Bounded here, at the one place a name enters the system, rather than truncated at
 * every reader. Do not raise this without re-checking the record's encoded size.
 */
const MAX_INSTANCE_NAME_BYTES: uint64 = 64

/**
 * Fractional Delegation Registry: global singleton, instance deployer.
 *
 * Holds the frac-system-wide admin and the default operator inherited by instance contracts.
 * Instance contracts resolve their roles by reading this registry's global state directly.
 */
@contract({ name: 'FracDelegationRegistry' })
export class FracDelegationRegistryContract extends BaseContract {
  /** Admin address; defaults to creator. Rotatable via `setAdmin`. */
  admin = GlobalState<Account>({ initialValue: Global.creatorAddress })
  /** Fallback operator for frac instances; defaults to creator */
  defaultOperator = GlobalState<Account>({ initialValue: Global.creatorAddress })
  /** gGov registry application ID */
  gGovRegistryApp = GlobalState<Application>({ key: fracRegistryGGovKey, initialValue: Application(0) })
  /** microALGO sent to an instance per `requestMBR` top-up. Configurable via `setMBRTopUp`. */
  mbrTopUp = GlobalState<uint64>({ initialValue: 2_000_000 })
  /** Last account numeric ID */
  lastAccountId = GlobalState<uint64>({ initialValue: 0 })
  /** Account registry; account ID + frac instance (numeric) IDs  */
  accounts = BoxMap<Account, FracRegAccount>({ keyPrefix: 'a' })
  /** Last instance numeric ID */
  lastInstanceNumId = GlobalState<uint64>({ initialValue: 0 })
  /** Instance registry; app ID + name + associated accounts + registered escrows */
  instances = BoxMap<Uint16, FracInstance>({ keyPrefix: 'i' })
  /**
   * Escrow assignment: escrow account -> instance numeric ID it belongs to. The presence of a
   * key enforces globally-unique escrow assignment; `registerEscrow` rejects an account that
   * already has an entry here.
   */
  escrows = BoxMap<Account, Uint16>({ keyPrefix: 'e' })
  /**
   * FracDelegationInstance approval program bytecode. Chunk-uploaded by admin;
   * read by createInstance when spawning a new instance app. Lets admins ship
   * instance factory code updates without redeploying the registry.
   * Existing instances are independent apps and are unaffected.
   */
  instanceApprovalBox = Box<bytes>({ key: 'Iap' })

  // ── Admin: config ─────────────────────────────────────────────────

  /** Caller must match this registry's stored `admin` (`BaseContract` override). */
  protected override ensureCallerIsAdmin(): void {
    loggedAssert(Txn.sender === this.admin.value, errUnauthorized)
  }

  /** Transfer admin to `newAdmin`. Admin only; zero address rejected. */
  public setAdmin(newAdmin: Account): void {
    this.ensureCallerIsAdmin()
    loggedAssert(newAdmin !== Global.zeroAddress, errUnauthorized)
    this.admin.value = newAdmin
  }

  /** Set the `defaultOperator` account. Admin only. */
  public setDefaultOperator(newDefaultOperator: Account): void {
    this.ensureCallerIsAdmin()
    this.defaultOperator.value = newDefaultOperator
  }

  /** Set the gGov registry application ID. Admin only. */
  public setGGovRegistryApp(appId: Application): void {
    this.ensureCallerIsAdmin()
    this.gGovRegistryApp.value = appId
  }

  /**
   * Set the amount sent per `requestMBR`. Admin only. Economic parameter: it trades how often instances
   * request against how much ALGO sits as available balance buffer in them. Leftovers always recoverable
   * via `withdrawALGO`.
   *
   * Unguarded, but keep it well above one vote record's max MBR; recommended: greater than 0.4 ALGO.
   * 384,100 microALGO at the largest shape `GGovVoteCast`/`FracVoteCast` could emit (1024 bytes),
   * plus the 1,000 `requestMBR` fee; below that, votes could start failing.
   * @param amount microALGO sent to an instance per `requestMBR` call
   */
  public setMBRTopUp(amount: uint64): void {
    this.ensureCallerIsAdmin()
    this.mbrTopUp.value = amount
  }

  /**
   * Withdraw ALGO from the registry app account to `receiver`. Admin only.
   * The AVM rejects the inner payment if it would drop the app account below its min
   * balance, so over-withdrawal fails atomically (no explicit balance check needed).
   * @param receiver Destination account
   * @param amount microALGO to withdraw
   */
  public withdrawALGO(receiver: Account, amount: uint64): void {
    this.ensureCallerIsAdmin()
    itxn.payment({ receiver, amount }).submit()
  }

  // ── Admin: lifecycle ──────────────────────────────────────────────

  /** App updatable by admin */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.ensureCallerIsAdmin()
  }

  /**
   * App deletable by admin.
   *
   * WARNING: Dangerous action. Instances created by this registry read role data from this
   * registry's global state. Deleting it breaks that lookup and removes the creator escape
   * hatch, because this app is their creator. Only delete this app after every bound instance
   * has been rebound to a replacement registry via the instance's `setRegistryApp`.
   *
   * NOTE: MBR is not recovered by this implementation — the whole account balance (base + any MBR,
   * including boxes' ones) stays locked forever. This should be a rare action; if recovery is ever
   * needed, update this method to delete every box first, then add a closeRemainderTo payment
   * (it fails if any box is still present). See GGovPeriodContract.deleteApplication() for
   * a reference implementation.
   */
  @baremethod({ allowActions: ['DeleteApplication'] })
  public deleteApplication(): void {
    this.ensureCallerIsAdmin()
  }

  // ── Admin: instance app bytecode ─────────────────────────---------

  /**
   * Upload (or re-upload) the whole FracDelegationInstance approval bytecode into a registry box in
   * one call. Admin only.
   *
   * Takes the program as three pages, because the network rejects any single application argument
   * over 4096 bytes and an ARC-4 `byte[]` spends 2 of those on its length prefix, so a page
   * carries at most 4094 bytes of program, and one argument could never hold a whole one. Three
   * pages (12282 bytes) cover an approval program grown into AVM v13's 7 extra program pages,
   * alongside the clear-state program sharing them. Pass the program in `page1` and leave the
   * trailing pages empty when it fits; the pages are simply concatenated here, so the split points
   * carry no meaning.
   *
   * Replaces a chunked `uploadInstanceApprovalPartial(startOffset, data)` that needed a full
   * 16-transaction group: total application arguments were capped at 2KB before AVM v13 raised the
   * limit to 16KB, so the bytecode had to be dribbled in 2000 bytes at a time.
   */
  public uploadInstanceApproval(page1: bytes, page2: bytes, page3: bytes): void {
    this.ensureCallerIsAdmin()

    const boxKey = Bytes`Iap`
    op.Box.delete(boxKey)
    op.Box.create(boxKey, page1.length + page2.length + page3.length)
    op.Box.replace(boxKey, 0, page1)
    if (page2.length > 0) {
      op.Box.replace(boxKey, page1.length, page2)
    }
    if (page3.length > 0) {
      op.Box.replace(boxKey, page1.length + page2.length, page3)
    }
  }

  // ── Admin: instance management ─────────────────────────---------

  /**
   * Spawn a fresh frac-instance app. Admin only.
   * @param name Instance label for reference.
   * @param mbrPayment Payment txn covering the new instance app's MBR. Receiver must be this registry's address.
   * @returns [instanceNumId, appId]
   */
  public createInstance(name: string, mbrPayment: gtxn.PaymentTxn): [Uint16, uint64] {
    this.ensureCallerIsAdmin()
    loggedAssert(Bytes(name).length <= MAX_INSTANCE_NAME_BYTES, errInstanceNameTooLong)
    loggedAssert(mbrPayment.receiver === Global.currentApplicationAddress, errUnauthorized)
    loggedAssert(this.instanceApprovalBox.exists, errInstanceAppNotConfigured)

    // AVM stack-bytes values are capped at 4096 bytes; approval can be up to 8192. Read the
    // approval box in two pages and pass them as a tuple. The AVM concatenates pages back
    // together at appcreate time; an empty trailing page is a no-op.
    const approvalKey = Bytes`Iap`
    const [approvalLen] = op.Box.length(approvalKey)
    const PAGE_SIZE: uint64 = 4096
    const page1Len: uint64 = approvalLen <= PAGE_SIZE ? approvalLen : PAGE_SIZE
    const page1: bytes = op.Box.extract(approvalKey, 0, page1Len)
    const page2: bytes =
      approvalLen > PAGE_SIZE ? op.Box.extract(approvalKey, PAGE_SIZE, approvalLen - PAGE_SIZE) : Bytes('')

    this.lastInstanceNumId.value++
    const instanceNum = u16(this.lastInstanceNumId.value)

    // Schema comes straight off the compiled child rather than hand-written constants (which used to
    // carry two unresolved TODOs and over-allocated 5/5 against an actual 1/3). Under AVM v13 a
    // global schema can be expanded by a later update — see FracDelegationSDK.updateInstanceApp — so
    // reserving spare slots only buys dead MBR.
    //
    // The one coupling this leaves: `compiled` is the FracDelegationInstance built into *this*
    // registry, so uploading a newer instance program to the `Iap` box that needs more globals means
    // rebuilding the registry too, or growing each spawned app afterwards.
    const compiled = compile(FracDelegationInstanceContract) // clearStateProgram + schema — approval comes from box

    // Pages are sized from the bytecode actually being deployed, not from a constant: an app gets
    // (1 + extraProgramPages) pages of 2048 bytes to hold approval + clear. Deliberately measured
    // against the BOX, not `compiled.extraProgramPages` — the box is the source of truth for what is
    // being created, and it exists precisely so instance code can be upgraded without redeploying
    // the registry. Sizing off the build-time compile would under-allocate the moment a newer,
    // larger instance program is uploaded. AVM v13 raised the ceiling to 7 extra pages (16KB).
    // ceil(n / 2048) - 1, written as (n - 1) / 2048 so the uint64 maths cannot underflow: the box is
    // asserted to exist above, so programBytes >= 1.
    const PROGRAM_PAGE_BYTES: uint64 = 2048
    const programBytes: uint64 = approvalLen + compiled.clearStateProgram.length
    const extraPages: uint64 = (programBytes - 1) / PROGRAM_PAGE_BYTES

    const created = itxn
      .applicationCall({
        approvalProgram: [page1, page2],
        // ABI create call: selector + encoded (uint16 instanceNum, string name)
        appArgs: [
          methodSelector(FracDelegationInstanceContract.prototype.createApplication),
          instanceNum.bytes,
          encodeArc4(name),
        ],
        clearStateProgram: compiled.clearStateProgram,
        extraProgramPages: extraPages,
        globalNumUint: compiled.globalUints,
        globalNumBytes: compiled.globalBytes,
      })
      .submit()
    const newApp = created.createdApp

    itxn
      .payment({
        receiver: newApp.address,
        amount: mbrPayment.amount,
      })
      .submit()

    this.instances(instanceNum).value = {
      appId: Application(newApp.id),
      name,
      numAccounts: 0,
      numEscrows: 0,
    }

    return [instanceNum, newApp.id]
  }

  /**
   * Send `mbrTopUp` amount to the instance registered under `instanceNumId`. Called as an inner txn
   * by that same instance when writing a box vote record left it below its minimum balance.
   * Policy: users never pay for vote record boxes MBR.
   *
   * Trust boundary: caller-app ID must match the appId registered for `instanceNumId`, analogous to
   * what `GGovRegistry.updatePeriodSummary` does. Matching on that rather than on the instance's app
   * creator is deliberate: instances can be rebound to a replacement registry via `setRegistryApp`,
   * which will be different from its creator.
   *
   * NOTE: pays its own fee, against the usual `fee: 0` pooling rule. The top-up is conditional on a
   * balance another voter can move between simulate and execution, so with pooling a group that
   * simulated without it could not cover the extra fee. Own fees make the voter's group fee invariant.
   * Its counterpart does the same - see `FracDelegationInstance.checkNeedMBR`.
   * @param instanceNumId Numeric ID of the calling instance
   */
  public requestMBR(instanceNumId: Uint16): void {
    const box = this.instances(instanceNumId)
    loggedAssert(box.exists, errInstanceAppNotExists)
    const instanceApp = box.value.appId
    loggedAssert(Global.callerApplicationId === instanceApp.id, errUnauthorized)
    itxn
      .payment({
        receiver: instanceApp.address,
        amount: this.mbrTopUp.value,
        fee: Global.minTxnFee,
      })
      .submit()
  }

  // ── Accounts (users) ─────────────────────────-----------------------------

  /** Get empty frac delegation registry account struct with `accountId` */
  protected getEmptyFracRegAccount(accountId: Uint32): FracRegAccount {
    return { accountId: accountId, instanceNumIds: [] }
  }

  /**
   * Get account's registry record if it exists, else an empty record
   * @param account Account to look up
   * @returns FracRegAccount for the account, or an empty record (accountId 0, no instances) if not registered
   */
  protected getAccountIfExists(account: Account): FracRegAccount {
    const box = this.accounts(account)
    if (box.exists) return box.value
    else return this.getEmptyFracRegAccount(u32(0))
  }

  /**
   * Get account's registry record if it exists, else an empty record
   * @param account account to look up
   * @returns FracRegAccount for the account, or an empty record (accountId 0, no instances) if not registered
   */
  @abimethod({ readonly: true })
  public getAccount(account: Account): FracRegAccount {
    return this.getAccountIfExists(account)
  }

  /**
   * Log each account's FracRegAccount record (empty record if not registered)
   * Used to fetch account records/instances quickly off-chain
   * @param accounts accounts to log
   */
  @abimethod({ readonly: true })
  public logAccounts(accounts: Account[]): void {
    for (const account of accounts) {
      log(encodeArc4(this.getAccountIfExists(account)))
    }
  }

  /**
   * Log an account's AlgoQuarters standing in each of gGov committees `committeeIds` across the frac
   * instances it belongs to - one `FracAccountCommitteeAq` per (instance, committee) pair. Readonly,
   * intended for simulate: it inner-calls each instance's `getAccountCommitteeAq`, joining the
   * instance identity, the committee's local numeric ID, the account's weight against the committee
   * total, and the instance's gGov power there.
   *
   * Both axes in one call on purpose. The caller that wants this - an account page showing "your
   * pooled power" - wants every committee across every pool, and splitting the committee axis into
   * separate calls costs a round-trip each while re-reading the same `accounts` and `instances`
   * boxes every time. The instance axis is the one that pages, because it is the axis whose
   * per-item cost includes an inner call.
   *
   * The account's instance list is paged by `offset`/`limit` (a slice of its `instanceNumIds`), so a
   * user in more instances than one call's resource budget allows can fetch the rest with follow-up
   * pages. The committee list is NOT paged: it is the caller's own list, so a caller too wide for
   * one call's budget splits it and issues the calls in parallel. The full instance count is logged
   * first (a `uint16`) so a caller learns how many pages exist; every subsequent log is one
   * `FracAccountCommitteeAq`, instance-major - `instanceNumIds` order starting at `offset`, and
   * within each instance, `committeeIds` order.
   *
   * A page may log fewer records than `limit * committeeIds.length`, so callers must not align
   * results by index. Each record names its own `instanceNumId` and echoes its own `committeeId`, so
   * every row self-identifies. Two reasons an instance yields nothing:
   * - The `instances` box is missing (cannot happen today; defensive against a future removal path).
   * - The instance's app has been deleted. It cannot be inner-called, and one dead instance must not
   *   take down the whole page, so it is skipped - same rule as `logInstanceCommittees`.
   *
   * Non-throwing otherwise: an unregistered account logs a count of 0 and nothing else, and an
   * instance that never synced a committee logs a record with `committeeNumId`/`userAq`/`totalAq`/
   * `totalVotes` 0 rather than being dropped (see the instance's `getAccountCommitteeAq`), so a
   * caller can tell "not synced" from "not there".
   *
   * @param account Account (user address) to look up
   * @param committeeIds 32-byte gGov committee IDs to report on, per instance
   * @param limit Max instances to cover on this call
   * @param offset Index into the account's `instanceNumIds` to start from
   */
  @abimethod({ readonly: true })
  public logAccountInstanceAQ(account: Account, committeeIds: CommitteeId[], limit: Uint16, offset: Uint16): void {
    const accountRecord = this.getAccountIfExists(account)
    const accountId = accountRecord.accountId
    const instanceNumIds = clone(accountRecord.instanceNumIds)
    const total: uint64 = instanceNumIds.length

    // Total first: lets a caller size the result set and page for the rest without a separate read.
    log(encodeArc4(u16(total)))

    const end: uint64 = offset.asUint64() + limit.asUint64()
    for (let i: uint64 = offset.asUint64(); i < end && i < total; i++) {
      const instanceNumId = instanceNumIds[i]
      // Present by construction: an id only enters an account's list via
      // getOrCreateAccountWithInstance, which requires the instance to exist. Checked anyway, since
      // skipping the whole instance is cheaper than the alternative of a failed inner call.
      const box = this.instances(instanceNumId)
      if (!box.exists) continue
      const instanceApp = box.value.appId

      // `app_params_get` reports absence rather than failing, which is the only way to tell a
      // deleted instance app from a live one before committing to an inner call to it. `appCreator`
      // over `appApprovalProgram` because only the existence flag is wanted - no reason to push a
      // program's worth of bytes onto the stack to throw away. Costs no extra reference: the app is
      // referenced by the inner call anyway.
      const [, appExists] = op.AppParams.appCreator(instanceApp)
      if (!appExists) continue

      for (const committeeId of committeeIds) {
        const standing = compileArc4(FracDelegationInstanceContract).call.getAccountCommitteeAq({
          appId: instanceApp,
          args: [accountId, committeeId],
        }).returnValue
        log(encodeArc4(standing))
      }
    }
  }

  /**
   * Log an account's internal vote records for gGov period `periodId` across the frac instances it
   * belongs to - one `FracAccountVotingRecord` (instance identity + `topicVotes`) per instance. The
   * simpler sibling of `logAccountInstanceAQ`. Readonly, intended for simulate: it inner-calls each
   * instance's `getVotingRecord` and tags the result with the instance identity from this registry's
   * own `instances` box (no committee join).
   *
   * Paged identically: `offset`/`limit` slice the account's `instanceNumIds`, the full instance
   * count is logged first (a `uint16`), then one `FracAccountVotingRecord` per paged instance in
   * `instanceNumIds` order. An instance where the account has not voted this period logs empty
   * `topicVotes`.
   *
   * Non-throwing: an unregistered account logs a count of 0 and nothing else.
   *
   * @param account Account (user address) to look up
   * @param periodId gGov period numeric ID
   * @param limit Max instances to log on this call
   * @param offset Index into the account's `instanceNumIds` to start from
   */
  @abimethod({ readonly: true })
  public logAccountVotingRecords(account: Account, periodId: Uint32, limit: Uint16, offset: Uint16): void {
    const accountRecord = this.getAccountIfExists(account)
    const accountId = accountRecord.accountId
    const instanceNumIds = clone(accountRecord.instanceNumIds)
    const total: uint64 = instanceNumIds.length

    log(encodeArc4(u16(total)))

    const end: uint64 = offset.asUint64() + limit.asUint64()
    for (let i: uint64 = offset.asUint64(); i < end && i < total; i++) {
      const instanceNumId = instanceNumIds[i]
      const instance = clone(this.instances(instanceNumId).value)
      const record = compileArc4(FracDelegationInstanceContract).call.getVotingRecord({
        appId: instance.appId,
        args: [periodId, accountId],
      }).returnValue
      const tagged: FracAccountVotingRecord = {
        instanceNumId,
        instanceAppId: instance.appId.id,
        instanceName: instance.name,
        isDelegated: record.isDelegated,
        topicVotes: clone(record.topicVotes),
      }
      log(encodeArc4(tagged))
    }
  }

  /**
   * Read one account's internal vote record for gGov period `periodId` in a single frac instance,
   * tagged with the instance's identity - the singular, directly-returning counterpart of
   * `logAccountVotingRecords`. Readonly, intended for simulate: it inner-calls the instance's
   * `getVotingRecord` and tags the result from this registry's own `instances` box. Empty
   * `topicVotes` means the account has not voted this period on the instance.
   *
   * Returning (rather than logging) the struct is also what registers `FracAccountVotingRecord` in
   * this contract's ARC-56, so SDKs decode the `logAccountVotingRecords` payload from the generated
   * struct instead of a hand-maintained copy.
   *
   * @param account Account (user address) to look up
   * @param instanceNumId Registry-assigned numeric ID of the instance
   * @param periodId gGov period numeric ID
   */
  @abimethod({ readonly: true })
  public getAccountVotingRecord(account: Account, instanceNumId: Uint16, periodId: Uint32): FracAccountVotingRecord {
    const accountRecord = this.getAccountIfExists(account)
    const accountId = accountRecord.accountId
    loggedAssert(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    const instance = clone(this.instances(instanceNumId).value)
    const record = compileArc4(FracDelegationInstanceContract).call.getVotingRecord({
      appId: instance.appId,
      args: [periodId, accountId],
    }).returnValue
    return {
      instanceNumId,
      instanceAppId: instance.appId.id,
      instanceName: instance.name,
      isDelegated: record.isDelegated,
      topicVotes: clone(record.topicVotes),
    }
  }

  /**
   * Log every registered instance's standing in gGov committee `committeeId` - one
   * `FracInstanceCommitteeStanding` per instance, joining the instance's identity from this
   * registry's `instances` box with the snapshot and AlgoQuarters ledger read from the instance
   * itself. Readonly, intended for simulate: it inner-calls each instance's `getCommitteeStanding`.
   *
   * The cross-instance transpose of `logAccountInstanceAQ`. That one asks "where does *this account*
   * stand across its instances"; this asks "where does *every instance* stand in this committee" -
   * the question behind a pools index, which otherwise costs a caller an instance listing plus two
   * reads per instance.
   *
   * Paged over the instance numeric ID range rather than a caller-supplied list: IDs are dense
   * (`lastInstanceNumId` only ever increments, and `instances` boxes are never removed), so the
   * registry can enumerate them itself and the caller needs no prior read at all. The full instance
   * count is logged first (a `uint16`), then one record per live instance in the page, ascending by
   * numeric ID starting at `offset + 1`.
   *
   * A page may log *fewer* records than it covers instances, so callers must not align results by
   * index - each record names its own `instanceNumId`. Two reasons a slot yields nothing:
   * - The `instances` box is missing (cannot happen today; defensive against a future removal path).
   * - The instance's app has been deleted. It cannot be inner-called, and one dead instance must not
   *   take down the whole page, so it is skipped. This is the on-chain equivalent of the existence
   *   filter an SDK-side caller would otherwise do with one algod lookup per instance.
   *
   * Non-throwing otherwise: an instance that never synced the committee logs a record with
   * `committeeNumId` 0 rather than being dropped, so a caller can tell "not synced" from "not there".
   *
   * @param committeeId 32-byte gGov committee ID
   * @param limit Max instances to cover on this call
   * @param offset Number of instance numeric IDs to skip (IDs are 1-based, so this starts at `offset + 1`)
   */
  @abimethod({ readonly: true })
  public logInstanceCommittees(committeeId: CommitteeId, limit: Uint16, offset: Uint16): void {
    const total: uint64 = this.lastInstanceNumId.value

    // Total first: lets a caller size the result set and page for the rest without a separate read.
    log(encodeArc4(u16(total)))

    const end: uint64 = offset.asUint64() + limit.asUint64()
    for (let i: uint64 = offset.asUint64(); i < end && i < total; i++) {
      const instanceNumId = u16(i + 1)
      const box = this.instances(instanceNumId)
      if (!box.exists) continue
      const instance = clone(box.value)

      // `app_params_get` reports absence rather than failing, which is the only way to tell a
      // deleted instance app from a live one before committing to an inner call to it. `appCreator`
      // over `appApprovalProgram` because only the existence flag is wanted - no reason to push a
      // program's worth of bytes onto the stack to throw away.
      const [, appExists] = op.AppParams.appCreator(instance.appId)
      if (!appExists) continue

      const standing = compileArc4(FracDelegationInstanceContract).call.getCommitteeStanding({
        appId: instance.appId,
        args: [committeeId],
      }).returnValue

      const tagged: FracInstanceCommitteeStanding = {
        instanceNumId,
        instanceAppId: instance.appId.id,
        instanceName: instance.name,
        instanceNumAccounts: instance.numAccounts,
        committeeNumId: standing.committeeNumId,
        totalVotes: standing.totalVotes,
        totalAq: standing.totalAq,
        ingestedAq: standing.ingestedAq,
        totalAccounts: standing.totalAccounts,
        numAccounts: standing.numAccounts,
      }
      log(encodeArc4(tagged))
    }
  }

  /**
   * One instance's standing in gGov committee `committeeId`, tagged with its identity - the
   * singular, directly-returning counterpart of `logInstanceCommittees`. Readonly.
   *
   * Returning (rather than logging) the struct is also what registers
   * `FracInstanceCommitteeStanding` in this contract's ARC-56, so SDKs decode the
   * `logInstanceCommittees` payload from the generated struct instead of a hand-maintained copy -
   * the same arrangement `getAccountVotingRecord` has with `logAccountVotingRecords`.
   *
   * Throws if the instance is not registered. Unlike the paged logger it does not skip a deleted
   * app: a caller naming one instance wants the failure, not a silent empty record.
   *
   * @param instanceNumId Registry-assigned numeric ID of the instance
   * @param committeeId 32-byte gGov committee ID
   */
  @abimethod({ readonly: true })
  public getInstanceCommittee(instanceNumId: Uint16, committeeId: CommitteeId): FracInstanceCommitteeStanding {
    loggedAssert(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    const instance = clone(this.instances(instanceNumId).value)
    const standing = compileArc4(FracDelegationInstanceContract).call.getCommitteeStanding({
      appId: instance.appId,
      args: [committeeId],
    }).returnValue
    return {
      instanceNumId,
      instanceAppId: instance.appId.id,
      instanceName: instance.name,
      instanceNumAccounts: instance.numAccounts,
      committeeNumId: standing.committeeNumId,
      totalVotes: standing.totalVotes,
      totalAq: standing.totalAq,
      ingestedAq: standing.ingestedAq,
      totalAccounts: standing.totalAccounts,
      numAccounts: standing.numAccounts,
    }
  }

  /**
   * Get validated account or create account, associating instance.
   * Callable by the associated instance app (the production path) or the registry admin
   * (bootstrap/administration path).
   * @param account Account to get or create ID for
   * @param instanceNumId Instance number ID to associate with the account
   * @returns FracRegAccount for the account, including the associated instance
   */
  public getOrCreateAccountWithInstance(account: Account, instanceNumId: Uint16): FracRegAccount {
    loggedAssert(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    const instance = clone(this.instances(instanceNumId).value)

    // sender must be the instance app itself, or the registry admin
    loggedAssert(Txn.sender === instance.appId.address || Txn.sender === this.admin.value, errUnauthorized)

    if (!this.accounts(account).exists) {
      this.lastAccountId.value++
      const accountId = u32(this.lastAccountId.value)
      this.accounts(account).value = this.getEmptyFracRegAccount(accountId)
    }

    const accountRecord = clone(this.accounts(account).value)
    let found = false
    for (const i of clone(accountRecord.instanceNumIds)) {
      if (i.asUint64() === instanceNumId.asUint64()) {
        found = true
        break
      }
    }
    if (!found) {
      accountRecord.instanceNumIds.push(instanceNumId)
      this.accounts(account).value = clone(accountRecord)

      instance.numAccounts++
      this.instances(instanceNumId).value = clone(instance)
    }

    return accountRecord
  }

  // ── Admin: escrows ─────────────────────────---------

  /**
   * Register `account` as an escrow of instance `instanceNumId`. Admin only.
   *
   * Enforces globally-unique escrow assignment: an account already recorded in the `escrows`
   * BoxMap (for any instance) is rejected with `errEscrowAssigned`. On success it records the
   * escrow -> instance mapping, bumps the instance's `numEscrows` counter, and inner-calls the
   * instance's `registerEscrow` so the account is appended to the instance's own escrows list.
   * @param instanceNumId Numeric ID of the target instance
   * @param account Escrow account to assign
   */
  public registerEscrow(instanceNumId: Uint16, account: Account): void {
    this.ensureCallerIsAdmin()
    loggedAssert(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    loggedAssert(!this.escrows(account).exists, errEscrowAssigned)
    const instance = clone(this.instances(instanceNumId).value)

    // Record the globally-unique escrow -> instance assignment.
    this.escrows(account).value = instanceNumId

    // Mirror the escrow into the instance's own escrows list (typed inner ABI call). Like
    // createInstance, this references only the instance's method signature, not its (box-hosted)
    // approval program, so the registry stays small.
    compileArc4(FracDelegationInstanceContract).call.registerEscrow({
      appId: instance.appId,
      args: [account],
    })

    instance.numEscrows++
    this.instances(instanceNumId).value = clone(instance)
  }

  // ── Escrow reads ──────────────────────────────────────────────────

  /**
   * Escrow on-chain getter. Resolve an escrow registration by returning its instance numeric ID
   * and app ID. Cross-app box reads are impossible on the AVM, so this is the read surface.
   * Mostly called via readonly inner txn by `GGovRegistry.importFracDelegations`.
   *
   * If the escrow is not registered to any instance, returns the zero sentinel so this stays a
   * plain read. Callers that must fail on an unassigned escrow enforce that themselves.
   * @param account Escrow account to resolve
   * @returns FracEscrowInstance with the instance numeric ID and app ID, or the zero sentinel if unassigned
   */
  @abimethod({ readonly: true })
  public getEscrow(account: Account): FracEscrowInstance {
    const escrowBox = this.escrows(account)
    if (!escrowBox.exists) {
      return { instanceNumId: u16(0), instanceAppId: 0 }
    }
    const instanceNumId = escrowBox.value
    const instanceBox = this.instances(instanceNumId)
    loggedAssert(instanceBox.exists, errInstanceAppNotExists) // invariant: registerEscrow only writes against live instances
    return { instanceNumId, instanceAppId: instanceBox.value.appId.id }
  }
}
