import {
  Account,
  Application,
  baremethod,
  Box,
  Bytes,
  bytes,
  compile,
  contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import { errInstanceAppNotConfigured, errUnauthorized } from '../base/errors.algo'
import { ensure, u32 } from '../base/utils.algo'
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
  /**
   * FracDelegationInstance approval program bytecode. Chunk-uploaded by admin;
   * read by createInstance when spawning a new instance app. Lets admins ship
   * instance approval-program upgrades without redeploying the registry. Existing
   * instances are independent apps and are unaffected.
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
    ensure(receiver !== Global.zeroAddress, errUnauthorized)
    itxn.payment({ receiver, amount }).submit()
  }

  // ── Admin: lifecycle ──────────────────────────────────────────────

  /** App updatable by admin */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.ensureCallerIsAdmin()
  }

  /** App deletable by admin */
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

  public createInstance(name: string, mbrPayment: gtxn.PaymentTxn): [Uint32, uint64] {
    this.ensureCallerIsAdmin()
    ensure(mbrPayment.receiver === Global.currentApplicationAddress, errUnauthorized)
    ensure(this.instanceApprovalBox.exists, errInstanceAppNotConfigured)

    // TODO: numeric id assignment, increment counter, etc
    // TODO: create instance box, check doesn't exist yet, register name

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

    const compiled = compile(FracDelegationInstanceContract) // clearStateProgram only — approval comes from box
    const created = itxn
      .applicationCall({
        approvalProgram: [page1, page2],
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

    // TODO: call instance and assing numeric id

    return [u32(5), newApp.id]
  }
}
