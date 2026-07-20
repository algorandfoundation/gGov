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
  errUnauthorized,
} from '../base/errors.algo'
import { FracEscrowInstance, FracInstance, FracRegAccount } from '../base/types.algo'
import { ensure, u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'

/**
 * Fractional Delegation Registry: global singleton, instance deployer.
 *
 * Holds the frac-system-wide admin and the default operator inherited by instance contracts.
 * Instance contracts resolve their roles by reading this registry's global state directly.
 */
@contract({ name: 'FracDelegationRegistry', stateTotals: { globalBytes: 20, globalUints: 44 } })
export class FracDelegationRegistryContract extends BaseContract {
  /** Admin address; defaults to creator. Rotatable via `setAdmin`. */
  admin = GlobalState<Account>({ initialValue: Global.creatorAddress })
  /** Fallback operator for frac instances; defaults to creator */
  defaultOperator = GlobalState<Account>({ initialValue: Global.creatorAddress })
  /** gGov registry application ID */
  gGovRegistryApp = GlobalState<Application>()
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
    ensure(Txn.sender === this.admin.value, errUnauthorized)
  }

  /** Transfer admin to `newAdmin`. Admin only; zero address rejected. */
  public setAdmin(newAdmin: Account): void {
    this.ensureCallerIsAdmin()
    ensure(newAdmin !== Global.zeroAddress, errUnauthorized)
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
   * Upload (or re-upload) a chunk of the FracDelegationInstance approval bytecode into
   * a registry box. Admin only. `startOffset === 0` deletes the existing box and creates
   * a fresh one at the chunk length; subsequent chunks resize/replace.
   */
  public uploadInstanceApprovalPartial(startOffset: uint64, data: bytes): void {
    this.ensureCallerIsAdmin()
    const boxKey = Bytes`Iap`
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

  // ── Admin: instance management ─────────────────────────---------

  /**
   * Spawn a fresh frac-instance app. Admin only.
   * @param name Instance label for reference.
   * @param mbrPayment Payment txn covering the new instance app's MBR. Receiver must be this registry's address.
   * @returns [instanceNumId, appId]
   */
  public createInstance(name: string, mbrPayment: gtxn.PaymentTxn): [Uint16, uint64] {
    this.ensureCallerIsAdmin()
    ensure(mbrPayment.receiver === Global.currentApplicationAddress, errUnauthorized)
    ensure(this.instanceApprovalBox.exists, errInstanceAppNotConfigured)

    // IMPORTANT: Always allocate the MAXIMUM AVM extraProgramPages (3) and reserve 2 extra
    // slots in each global-schema dimension (uint + bytes). This headroom lets the
    // instance contract grow up to the AVM hard ceiling without ever requiring a registry
    // redeploy. Do NOT shrink these constants when adding fields to FracDelegationInstanceContract.
    // TODO: update final values when instance contract is finished (X, Y)
    // TODO: decide extra slots number (Z)
    const INSTANCE_GLOBAL_NUM_UINT: uint64 = 5 // X used today + Z reserved
    const INSTANCE_GLOBAL_NUM_BYTES: uint64 = 5 // Y used today + Z reserved
    const INSTANCE_EXTRA_PROGRAM_PAGES: uint64 = 3 // AVM max → 8192-byte approval/clear ceiling

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

    const compiled = compile(FracDelegationInstanceContract) // clearStateProgram only — approval comes from box
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
        extraProgramPages: INSTANCE_EXTRA_PROGRAM_PAGES,
        globalNumUint: INSTANCE_GLOBAL_NUM_UINT,
        globalNumBytes: INSTANCE_GLOBAL_NUM_BYTES,
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
   * Get validated account or create account, associating instance.
   * Callable by the associated instance app (the production path) or the registry admin
   * (bootstrap/administration path).
   * @param account Account to get or create ID for
   * @param instanceNumId Instance number ID to associate with the account
   * @returns FracRegAccount for the account, including the associated instance
   */
  public getOrCreateAccountWithInstance(account: Account, instanceNumId: Uint16): FracRegAccount {
    ensure(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    const instance = clone(this.instances(instanceNumId).value)

    // sender must be the instance app itself, or the registry admin
    ensure(Txn.sender === instance.appId.address || Txn.sender === this.admin.value, errUnauthorized)

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
    ensure(this.instances(instanceNumId).exists, errInstanceAppNotExists)
    ensure(!this.escrows(account).exists, errEscrowAssigned)
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
   * Mostly called via readonly inner txn by `GGovRegistry.importFracDelegation`.
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
    ensure(instanceBox.exists, errInstanceAppNotExists) // invariant: registerEscrow only writes against live instances
    return { instanceNumId, instanceAppId: instanceBox.value.appId.id }
  }
}
