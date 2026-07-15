import { FracDelegationInstanceClient } from '../generated/FracDelegationInstanceClient'
import {
  InstanceConstructorArgs,
  SenderWithSigner,
  InstanceMethodBuilderArgs,
  FracDelegationInstanceContractArgs,
} from './types'
import { requireWriterWithClient } from '../util/requiresSender'
import { FracDelegationReaderSDK } from './sdkReader'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors'
import { createTxnExecutor } from '../util/txnExecutor'

export class FracDelegationSDK extends FracDelegationReaderSDK {
  public writerAccount?: SenderWithSigner
  public writeClient?: FracDelegationInstanceClient

  constructor({ writerAccount, ...rest }: InstanceConstructorArgs) {
    super(rest)
    if (writerAccount) {
      this.writerAccount = writerAccount
      this.writeClient = new FracDelegationInstanceClient({
        algorand: this.algorand,
        appId: this.appId,
        defaultSender: writerAccount?.sender,
        defaultSigner: writerAccount?.signer,
      })
    }
  }

  private makeTxnExecutor = createTxnExecutor(
    this,
    () => this.writeClient!.newGroup(),
    wrapErrorsInternal,
    () => this.writerAccount,
    () => this.algorand.client.algod,
  )

  // ── Admin: roles + config ────────────────────────────────────────

  @requireWriterWithClient()
  @wrapErrors()
  makeSetOperatorTxns({
    newOperator,
    builder,
  }: FracDelegationInstanceContractArgs['setOperator(address)void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setOperator({ args: { newOperator } })
    return builder
  }

  setOperator = this.makeTxnExecutor({
    maker: this.makeSetOperatorTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetRegistryAppTxns({
    appId,
    builder,
  }: FracDelegationInstanceContractArgs['setRegistryApp(uint64)void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setRegistryApp({ args: { appId } })
    return builder
  }

  setRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetRegistryAppTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeWithdrawALGOTxns({
    receiver,
    amount,
    builder,
  }: FracDelegationInstanceContractArgs['withdrawALGO(address,uint64)void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // extraFee covers the single inner payment
    builder = builder.withdrawAlgo({ args: { receiver, amount }, extraFee: (1000).microAlgo() })
    return builder
  }

  withdrawALGO = this.makeTxnExecutor({
    maker: this.makeWithdrawALGOTxns,
  })

  // ── Escrows ──────────────────────────────────────────────────────

  /**
   * Append `account` to the instance's escrows list. Normally driven by the registry via
   * `FracDelegationRegistrySDK.registerEscrow` (which also enforces unique assignment and keeps
   * its counter in sync); calling this directly is the admin escape hatch and bypasses both.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeRegisterEscrowTxns({
    account,
    builder,
  }: FracDelegationInstanceContractArgs['registerEscrow(address)void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.registerEscrow({ args: { account } })
    return builder
  }

  registerEscrow = this.makeTxnExecutor({
    maker: this.makeRegisterEscrowTxns,
  })

  // ── Admin: lifecycle ────────────────────────────────────────────

  /**
   * Update a deployed instance app program to the `FracDelegationInstance` build exported by this
   * `frac-delegation-sdk` version. The instance write client compiles the current approval/clear
   * programs from its embedded app spec, so the on-chain code is replaced with the version bundled
   * here. Admin-only (the resolved admin, i.e. the registry's `admin`).
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeUpdateInstanceAppTxns({ note, builder }: InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    return builder.update.bare({ note })
  }

  updateInstanceApp = this.makeTxnExecutor({
    maker: this.makeUpdateInstanceAppTxns,
  })

  /** Delete the `FracDelegationInstance` app. Admin-only. */
  @requireWriterWithClient()
  @wrapErrors()
  makeDeleteInstanceAppTxns({ note, builder }: InstanceMethodBuilderArgs) {
    // TODO: recover MBR and clean up boxes once the contract supports it — see the TODO on the
    // contract's deleteApplication baremethod. Reference: GGovSDK.deletePeriodApp() in
    // ggov-sdk/src/period/sdk.ts (enumerates boxes, deletes them in pages, then closes out).
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.delete.bare({ note })
    return builder
  }

  deleteInstanceApp = this.makeTxnExecutor({
    maker: this.makeDeleteInstanceAppTxns,
  })
}
