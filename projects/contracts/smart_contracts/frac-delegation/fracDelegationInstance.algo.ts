import {
  abimethod,
  Account,
  baremethod,
  Box,
  Bytes,
  clone,
  contract,
  Global,
  GlobalState,
  itxn,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { Uint16 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import { errRegistryMissing, errUnauthorized } from '../base/errors.algo'
import { ensure } from '../base/utils.algo'

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
