import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { FracDelegationRegistrySDK, SendResult, executeTxns } from '../registry'
import { FracDelegationInstanceClient } from '../generated/FracDelegationInstanceClient'
import {
  ConstructorArgs,
  SenderWithSigner,
  InstanceMethodBuilderArgs,
  FracDelegationInstanceContractArgs,
} from './types'
import { requireWriter } from '../util/requiresSender'
import { FracDelegationReaderSDK } from './sdkReader'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors'
import { committeeIdToRaw } from '../util/comitteeId'
import { MAX_GROUP_SIZE, REF_SLOTS_PER_APP_CALL } from '../constants'

/** Keeps otherwise-identical padding app calls from colliding into one duplicate txn ID. */
const noteNonce = () => Math.floor(Math.random() * 100_000_000)

export class FracDelegationSDK extends FracDelegationReaderSDK {
  public writerAccount?: SenderWithSigner
  /** Composed registry SDK (writer-enabled). Reach registry writes/reads via `sdk.registry.X`. */
  declare public registry: FracDelegationRegistrySDK
  /** instanceNumId → cached writer client. */
  protected instanceWriteClientCache: Map<bigint, FracDelegationInstanceClient> = new Map()

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest)
    this.writerAccount = writerAccount
    this.registry = new FracDelegationRegistrySDK({
      writerAccount,
      ...rest,
    })
  }

  // ── Instance client cache ────────────────────────────────────────

  protected async getInstanceWriteClient(instanceNumId: bigint | number): Promise<FracDelegationInstanceClient> {
    if (!this.writerAccount) throw new Error('writerAccount required')
    const id = BigInt(instanceNumId)
    const cached = this.instanceWriteClientCache.get(id)
    if (cached) return cached
    const appId = await this.getInstanceAppId(id)
    const client = new FracDelegationInstanceClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.writerAccount.sender,
      defaultSigner: this.writerAccount.signer,
    })
    this.instanceWriteClientCache.set(id, client)
    return client
  }

  // ── Executor factory ─────────────────────────────────────────────

  /**
   * Instance-side executor factory. Resolves the per-instance client at call time, binds the
   * empty-group factory to that client, then runs the standard executeTxns flow (which also
   * auto-increases opcode budget via getIncreaseBudgetBuilder).
   */
  private makeInstanceTxnExecutor = <A extends { instanceNumId: bigint | number }, R = SendResult>({
    maker,
    returnTransformer,
    sendParams,
  }: {
    maker: (args: A) => any
    returnTransformer?: (result: SendResult) => R
    sendParams?: SendParams
  }) => {
    return async (args: Omit<A, 'builder' | 'client'>): Promise<R> => {
      if (!this.writerAccount) throw new Error('writerAccount not set on the SDK instance')
      const client = await this.getInstanceWriteClient(args.instanceNumId)
      const result = await wrapErrorsInternal(
        executeTxns({
          txnBuilder: (a: any) => (maker as any).call(this, { ...a, client }),
          txnBuilderArgs: { ...(args as object) } as any,
          emptyGroupBuilder: () => client.newGroup(),
          sendParams,
          writerAccount: this.writerAccount,
          algod: this.algorand.client.algod,
        }),
      )
      return returnTransformer ? returnTransformer(result) : (result as R)
    }
  }

  // ── Admin: roles + config ────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeSetOperatorTxns({
    instanceNumId: _instanceNumId,
    newOperator,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['setOperator(address)void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.setOperator({ args: { newOperator }, note })
  }

  setOperator = this.makeInstanceTxnExecutor({ maker: this.makeSetOperatorTxns })

  @requireWriter()
  @wrapErrors()
  makeSetRegistryAppTxns({
    instanceNumId: _instanceNumId,
    appId,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['setRegistryApp(uint64)void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.setRegistryApp({ args: { appId }, note })
  }

  setRegistryApp = this.makeInstanceTxnExecutor({ maker: this.makeSetRegistryAppTxns })

  /**
   * Withdraw `amount` µAlgo from the instance app account to `receiver`. Admin only. Exposed as
   * `withdrawInstanceALGO` to avoid colliding with the registry's `withdrawALGO` on this SDK;
   * the on-chain method is `withdrawALGO`.
   */
  @requireWriter()
  @wrapErrors()
  makeWithdrawInstanceALGOTxns({
    instanceNumId: _instanceNumId,
    receiver,
    amount,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['withdrawALGO(address,uint64)void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    // extraFee covers the single inner payment
    return builder.withdrawAlgo({ args: { receiver, amount }, note, extraFee: (1000).microAlgo() })
  }

  withdrawInstanceALGO = this.makeInstanceTxnExecutor({ maker: this.makeWithdrawInstanceALGOTxns })

  // ── Escrows ──────────────────────────────────────────────────────

  /**
   * Append `account` to the instance's escrows list. Normally driven by the registry via
   * `FracDelegationRegistrySDK.registerEscrow` (which also enforces unique assignment and keeps
   * its counter in sync); calling this directly is the admin escape hatch and bypasses both.
   * Exposed as `registerInstanceEscrow` to avoid colliding with the registry's `registerEscrow`
   * on this SDK; both on-chain methods registry and instance are `registerEscrow`.
   */
  @requireWriter()
  @wrapErrors()
  makeRegisterInstanceEscrowTxns({
    instanceNumId: _instanceNumId,
    account,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['registerEscrow(address)void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.registerEscrow({ args: { account }, note })
  }

  registerInstanceEscrow = this.makeInstanceTxnExecutor({ maker: this.makeRegisterInstanceEscrowTxns })

  // ── Reference-slot padding ───────────────────────────────────────

  /**
   * Escrow count to size reference padding from — an upper bound, never an under-estimate.
   *
   * `syncPeriod` actually sizes against the committee snapshot rather than `escrows`, but `escrows`
   * is append-only and the snapshot is rebuilt from it, so `escrowsVotes.length <= escrows.length`
   * always holds. Over-padding costs one min fee per spare txn; under-padding fails the group.
   */
  private async escrowCountUpperBound(instanceNumId: bigint | number) {
    return (await this.getEscrows(instanceNumId)).length
  }

  /**
   * Pad `builder` with no-op `increaseBudget` calls until the group carries `refSlots` reference
   * slots. Foreign/box references are pooled across the group but capped at 8 per app call, so a
   * method touching more than 8 of them needs company in the group or resource population fails
   * with "No more transactions below reference limit".
   *
   * `increaseBudget` is unauthenticated and does nothing at `itxns: 0`, so a pad costs one min fee
   * and buys 700 opcodes as a bonus. It has to be an app call to the instance itself: resource
   * population only parks a box ref on a transaction that already has the box's owning app
   * available, and these calls do.
   *
   * Do not rely on `getIncreaseBudgetBuilder` for this. It prepends an increaseBudget only when the
   * group is over its *opcode* budget, which has masked the reference shortfall here by accident —
   * see the TODO in `util/increaseBudget.ts`. Sizing the padding explicitly keeps these methods
   * working if that heuristic ever stops firing.
   */
  private padForRefSlots<T extends { increaseBudget(args: unknown): T }>(builder: T, refSlots: number, label: string) {
    const appCalls = Math.ceil(refSlots / REF_SLOTS_PER_APP_CALL)
    if (appCalls > MAX_GROUP_SIZE) {
      throw new Error(
        `${label} needs ${refSlots} reference slots (${appCalls} app calls), over the ${MAX_GROUP_SIZE}-txn group ` +
          `limit: this instance has too many escrows to ${label} in a single group.`,
      )
    }
    for (let i = 1; i < appCalls; i++) {
      // Distinct notes: otherwise identical pads would collide into one duplicate txn ID.
      builder = builder.increaseBudget({ args: { itxns: 0 }, note: `${label}-refs-${i}-${noteNonce()}` })
    }
    return builder
  }

  // ── Committees ───────────────────────────────────────────────────

  /**
   * Sync the instance's snapshot of gGov committee `committeeId` from the gGov registry
   * (resolved from the frac registry's `gGovRegistryApp`). Operator only.
   *
   * Rebuilds `committees(committeeId)` from scratch, so it is safe to re-run after more escrows
   * are registered. The gGov registry app and the boxes both apps touch are resolved
   * automatically via resource population; the instance app account pays the box MBR, which
   * grows with the escrow count.
   *
   * The group is padded with no-op app calls to carry the per-escrow references — see
   * `padForRefSlots`.
   */
  @requireWriter()
  @wrapErrors()
  async makeSyncCommitteeTxns({
    instanceNumId,
    committeeId,
    note,
    client,
    builder,
  }: Omit<FracDelegationInstanceContractArgs['syncCommittee(byte[32])(uint16,uint32[],uint32)'], 'committeeId'> & {
    instanceNumId: bigint | number
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    const numEscrows = await this.escrowCountUpperBound(instanceNumId)
    // Slots: the gGov registry reads one box per escrow to resolve its voting power, plus a fixed
    // 5 boxes (this instance's escrows + committees, the registry's committee metadata and its
    // account-id map) and 2 app refs (the gGov registry, and registryApp which resolveOperator
    // reads). Measured against simulate: N=3 -> 10, N=6 -> 13, N=9 -> 16, N=12 -> 19.
    builder = this.padForRefSlots(builder, numEscrows + 7, 'syncCommittee')
    // extraFee covers the inner calls to the gGov registry: one getCommitteeMetadata, plus one
    // tryGetGovVotingPower per registered escrow.
    const innerCalls = 1 + numEscrows
    return builder.syncCommittee({
      args: { committeeId: committeeIdToRaw(committeeId) },
      note,
      extraFee: (innerCalls * 1000).microAlgo(),
    })
  }

  syncCommittee = this.makeInstanceTxnExecutor({ maker: this.makeSyncCommitteeTxns })

  // ── Periods ──────────────────────────────────────────────────────

  /**
   * Sync the instance's snapshot of the gGov period at `periodApp`. Operator only.
   *
   * Records the period's identity and topic shape, and zero-fills its vote tallies — the aggregate
   * cache plus one box per escrow of the committee snapshot the period is bound to. The period's
   * committee must already be synced (`syncCommittee`) and the period marked ready.
   *
   * Re-runnable while no vote has landed yet; re-sync after a `syncCommittee` to pick up newly
   * registered escrows. Unlike `syncCommittee` this makes a single inner call regardless of escrow
   * count, since the per-escrow voting power is read from the local committee box. The period app
   * and every box touched are resolved automatically via resource population; the instance app
   * account pays the box MBR, which grows with escrow and topic count.
   *
   * The group is padded with no-op app calls when the escrow count needs more reference slots than
   * one transaction carries — see `syncPeriodRefSlots`.
   */
  @requireWriter()
  @wrapErrors()
  async makeSyncPeriodTxns({
    instanceNumId,
    periodApp,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['syncPeriod(uint64)(uint64,byte[32],uint16,uint32,uint32,uint32[],uint8)'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    // Slots: N escrow boxes + periods + periodVoteCache + committees + the period app's
    // topicOptionsArr box (read by the getPeriodShort inner call) + 2 app refs (periodApp, and
    // registryApp which resolveOperator reads). Measured against simulate: N=6 -> 12, N=8 -> 14.
    builder = this.padForRefSlots(builder, (await this.escrowCountUpperBound(instanceNumId)) + 6, 'syncPeriod')
    // extraFee covers the single inner call to the period app: getPeriodShort.
    return builder.syncPeriod({ args: { periodApp }, note, extraFee: (1000).microAlgo() })
  }

  syncPeriod = this.makeInstanceTxnExecutor({ maker: this.makeSyncPeriodTxns })

  // ── Admin: lifecycle ────────────────────────────────────────────

  /**
   * Update a deployed instance app program to the `FracDelegationInstance` build exported by this
   * `frac-delegation-sdk` version. The instance write client compiles the current approval/clear
   * programs from its embedded app spec, so the on-chain code is replaced with the version bundled
   * here. Admin-only (the resolved admin, i.e. the registry's `admin`).
   */
  @requireWriter()
  @wrapErrors()
  makeUpdateInstanceAppTxns({
    instanceNumId: _instanceNumId,
    note,
    client,
    builder,
  }: {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.update.bare({ note })
  }

  updateInstanceApp = this.makeInstanceTxnExecutor({ maker: this.makeUpdateInstanceAppTxns })

  /** Delete the `FracDelegationInstance` app. Admin-only. */
  @requireWriter()
  @wrapErrors()
  makeDeleteInstanceAppTxns({
    instanceNumId: _instanceNumId,
    note,
    client,
    builder,
  }: {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    // TODO: recover MBR and clean up boxes once the contract supports it — see the TODO on the
    // contract's deleteApplication baremethod. Reference: GGovSDK.deletePeriodApp() in
    // ggov-sdk/src/period/sdk.ts (enumerates boxes, deletes them in pages, then closes out).
    builder = builder ?? client.newGroup()
    return builder.delete.bare({ note })
  }

  deleteInstanceApp = this.makeInstanceTxnExecutor({ maker: this.makeDeleteInstanceAppTxns })
}
