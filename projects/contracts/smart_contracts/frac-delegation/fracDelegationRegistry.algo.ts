import {
  Account,
  Application,
  baremethod,
  contract,
  Global,
  GlobalState,
  itxn,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { BaseContract } from '../base/base.algo'
import { errUnauthorized } from '../base/errors.algo'
import { ensure } from '../base/utils.algo'

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

  // ── Admin ─────────────────────────────────────────────────────────

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
}
