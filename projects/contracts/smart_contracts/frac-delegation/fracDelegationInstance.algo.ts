import {
  abimethod,
  Account,
  baremethod,
  Bytes,
  contract,
  Global,
  GlobalState,
  itxn,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { BaseContract } from '../base/base.algo'
import { errAppGlobalKeyNotFound, errNotOperator, errUnauthorized } from '../base/errors.algo'
import { ensure } from '../base/utils.algo'

/**
 * Fractional Delegation Instance: per-protocol delegation contract.
 *
 * Resolves its admin and operator from the registry global state.
 */
@contract({ name: 'FracDelegationInstance', stateTotals: { globalBytes: 8, globalUints: 8 } })
export class FracDelegationInstanceContract extends BaseContract {
  /** `FracDelegationRegistry` app ID; initialized at creator app ID (defaults to zero if non-app)*/
  registryApp = GlobalState<uint64>({ initialValue: Global.callerApplicationId })
  /** Instance operator; zero address falls back to the registry's `defaultOperator` */
  operator = GlobalState<Account>({ initialValue: Global.zeroAddress })

  // ── Role resolution ───────────────────────────────────────────────

  /** Instance admin is the registry's `admin` */
  protected resolveAdmin(): Account {
    const [value, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`admin`)
    ensure(exists, errAppGlobalKeyNotFound)
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
      ensure(exists, errAppGlobalKeyNotFound)
      return Account(value)
    }
    return this.operator.value
  }

  /** Caller must match the resolved admin (`BaseContract` override). */
  protected override ensureCallerIsAdmin(): void {
    ensure(Txn.sender === this.resolveAdmin(), errUnauthorized)
  }

  /** Caller must match the resolved operator. */
  protected ensureCallerIsOperator(): void {
    ensure(Txn.sender === this.resolveOperator(), errNotOperator)
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

  /** Set the `registryApp` ID. Admin only. */
  public setRegistryApp(appId: uint64): void {
    const [_, exists] = op.AppGlobal.getExBytes(this.registryApp.value, Bytes`admin`)
    if (!exists) {
      ensure(Txn.sender === Global.creatorAddress, errUnauthorized)
    } else {
      this.ensureCallerIsAdmin()
    }
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
    ensure(receiver !== Global.zeroAddress, errUnauthorized)
    itxn.payment({ receiver, amount }).submit()
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
  }
}
