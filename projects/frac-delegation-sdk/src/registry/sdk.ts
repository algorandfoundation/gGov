import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import { FracDelegationRegistryClient, FracDelegationRegistryFactory } from '../generated/FracDelegationRegistryClient'
import { ConstructorArgs, SenderWithSigner, CommonMethodBuilderArgs, FracDelegationRegistryContractArgs } from './types'
import { requireWriterWithClient } from '../util/requiresSender'
import { FracDelegationRegistryReaderSDK } from './sdkReader'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors'
import { createTxnExecutor } from '../util/txnExecutor'

export class FracDelegationRegistrySDK extends FracDelegationRegistryReaderSDK {
  public writerAccount?: SenderWithSigner
  public writeClient?: FracDelegationRegistryClient

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest)
    if (writerAccount) {
      this.writerAccount = writerAccount
      this.writeClient = new FracDelegationRegistryClient({
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
  makeSetAdminTxns({
    newAdmin,
    builder,
  }: FracDelegationRegistryContractArgs['setAdmin(address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setAdmin({ args: { newAdmin } })
    return builder
  }

  setAdmin = this.makeTxnExecutor({
    maker: this.makeSetAdminTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetDefaultOperatorTxns({
    newDefaultOperator,
    builder,
  }: FracDelegationRegistryContractArgs['setDefaultOperator(address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setDefaultOperator({ args: { newDefaultOperator } })
    return builder
  }

  setDefaultOperator = this.makeTxnExecutor({
    maker: this.makeSetDefaultOperatorTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetGGovRegistryAppTxns({
    appId,
    builder,
  }: FracDelegationRegistryContractArgs['setGGovRegistryApp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setGGovRegistryApp({ args: { appId } })
    return builder
  }

  setGGovRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetGGovRegistryAppTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeWithdrawALGOTxns({
    receiver,
    amount,
    builder,
  }: FracDelegationRegistryContractArgs['withdrawALGO(address,uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // extraFee covers the single inner payment
    builder = builder.withdrawAlgo({ args: { receiver, amount }, extraFee: (1000).microAlgo() })
    return builder
  }

  withdrawALGO = this.makeTxnExecutor({
    maker: this.makeWithdrawALGOTxns,
  })

  // ── Admin: lifecycle ────────────────────────────────────────────

  /**
   * Delete the `FracDelegationRegistry` app. Admin-only (the contract's `deleteApplication`
   * baremethod checks the caller is the admin directly — no inner call). On deletion the AVM
   * closes the registry app account and sends its residual ALGO to the deleting sender, so
   * withdraw any meaningful balance first.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeDeleteApplicationTxns({ builder }: CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.delete.bare({})
    return builder
  }

  deleteApplication = this.makeTxnExecutor({
    maker: this.makeDeleteApplicationTxns,
  })

  // ── Bootstrap: deploy + fund + optional setup ────────────────────

  /**
   * Deploy a fresh `FracDelegationRegistry` app, seed its MBR, and optionally configure
   * the gGov registry app id and default operator. Returns the writer-enabled registry SDK
   * bound to the new app.
   */
  static async createRegistry({
    algorand,
    deployer,
    defaultOperatorAccount,
    gGovRegistryAppId,
    initialFundingAlgos,
    update = false,
  }: {
    algorand: AlgorandClient
    deployer: SenderWithSigner
    defaultOperatorAccount?: string | Address
    gGovRegistryAppId?: bigint | number
    initialFundingAlgos?: bigint | number
    update?: boolean
  }): Promise<{ sdk: FracDelegationRegistrySDK; appClient: FracDelegationRegistryClient }> {
    const factory = algorand.client.getTypedAppFactory(FracDelegationRegistryFactory, {
      defaultSender: deployer.sender,
      defaultSigner: deployer.signer,
    })
    const { appClient } = await factory.deploy({
      onUpdate: update ? 'update' : 'append',
      onSchemaBreak: update ? 'fail' : 'append',
      createParams: {
        extraProgramPages: 3,
      },
    })

    // Seed the registry's account: covers base MBR only (no boxes for now).
    const fundingAlgos = BigInt(initialFundingAlgos ?? 1n)
    await algorand.send.payment({
      sender: deployer.sender,
      receiver: appClient.appAddress,
      amount: fundingAlgos.algo(),
    })

    const sdk = new FracDelegationRegistrySDK({
      algorand,
      registryAppId: appClient.appId,
      writerAccount: deployer,
    })

    if (gGovRegistryAppId !== undefined) {
      await sdk.setGGovRegistryApp({ appId: BigInt(gGovRegistryAppId) })
    }
    if (defaultOperatorAccount !== undefined) {
      const newDefaultOperator =
        typeof defaultOperatorAccount === 'string' ? defaultOperatorAccount : defaultOperatorAccount.toString()
      await sdk.setDefaultOperator({ newDefaultOperator })
    }

    return { sdk, appClient }
  }
}
