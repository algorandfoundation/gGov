import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import {
  FracDelegationRegistryClient,
  FracDelegationRegistryComposer,
  FracDelegationRegistryFactory,
} from '../generated/FracDelegationRegistryClient'
import { APP_SPEC as INSTANCE_APP_SPEC } from '../generated/FracDelegationInstanceClient'
import { ConstructorArgs, SenderWithSigner, CommonMethodBuilderArgs, FracDelegationRegistryContractArgs } from './types'
import { requireWriterWithClient } from '../util/requiresSender'
import { FracDelegationRegistryReaderSDK } from './sdkReader'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors'
import { createTxnExecutor } from '../util/txnExecutor'
import { chunk } from '../util/chunk'
import { BODY_CHUNK_BYTES, DEFAULT_INSTANCE_MBR_MICROALGOS, MAX_GROUP_SIZE } from '../constants'

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
   *
   * WARNING: Dangerous action — understand the implications before calling.
   * See the `deleteApplication` contract's method docstring for details.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeDeleteApplicationTxns({ builder }: CommonMethodBuilderArgs) {
    // TODO: query known instances and reject if any still reference this registry app.
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.delete.bare({})
    return builder
  }

  deleteApplication = this.makeTxnExecutor({
    maker: this.makeDeleteApplicationTxns,
  })

  // ── Admin: instance bytecode upload ────────────────────────-------

  @requireWriterWithClient()
  @wrapErrors()
  makeUploadInstanceApprovalPartialTxns({
    startOffset,
    data,
    note,
    builder,
  }: FracDelegationRegistryContractArgs['uploadInstanceApprovalPartial(uint64,byte[])void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    return builder.uploadInstanceApprovalPartial({ args: { startOffset, data }, note })
  }

  uploadInstanceApprovalPartial = this.makeTxnExecutor({
    maker: this.makeUploadInstanceApprovalPartialTxns,
  })

  /** Upload the full FracDelegationInstance approval bytecode, chunked into groups of up to 16 txns. */
  @requireWriterWithClient()
  @wrapErrors()
  async uploadInstanceApprovalProgram({
    bytecode,
    note,
  }: {
    bytecode: Uint8Array
    note?: string | Uint8Array
  }): Promise<void> {
    const chunks = chunk(Array.from(bytecode), BODY_CHUNK_BYTES)
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    )
    for (const group of groups) {
      let builder: FracDelegationRegistryComposer<any> = this.writeClient!.newGroup()
      for (const { index, data: chunkData } of group) {
        // The maker is @wrapErrors-decorated so it returns a Promise; await to unwrap.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        builder = await this.makeUploadInstanceApprovalPartialTxns({
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          note,
          builder,
        })
      }
      await builder.send()
    }
  }

  // ── Admin: addInstance (paired payment + createInstance) ─────────

  @requireWriterWithClient()
  @wrapErrors()
  async makeAddInstanceTxns({
    name,
    mbrAmount,
    note,
    builder,
  }: Omit<FracDelegationRegistryContractArgs['createInstance(string,pay)(uint32,uint64)'], 'mbrPayment'> & {
    mbrAmount?: bigint | number
  } & CommonMethodBuilderArgs) {
    const writer = this.writerAccount!
    const mbr = BigInt(mbrAmount ?? DEFAULT_INSTANCE_MBR_MICROALGOS)
    const mbrPayment = await this.algorand.createTransaction.payment({
      sender: writer.sender,
      receiver: this.writeClient!.appAddress,
      amount: { microAlgo: mbr } as any,
    } as any)
    builder = builder ?? this.writeClient!.newGroup()
    return builder.createInstance({
      args: { name, mbrPayment },
      note,
      extraFee: (2000).microAlgo(), // two inner txns (appcreate + MBR-forwarding payment)
    })
  }

  addInstance = this.makeTxnExecutor<typeof this.makeAddInstanceTxns, bigint>({
    maker: this.makeAddInstanceTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? []
      const tup = returns[returns.length - 1] ?? returns[0]
      return BigInt(Array.isArray(tup) ? tup[0] : tup)
    },
  })

  // ── Bootstrap: deploy + fund + upload instance bytecode + optional setup ──

  /**
   * Deploy a fresh `FracDelegationRegistry` app, seed its MBR, upload the FracDelegationInstance
   * approval bytecode into the registry's approval box, and optionally configure the gGov registry
   * app id and default operator. Returns the writer-enabled registry SDK bound to the new app.
   *
   * The instance approval bytecode comes from the generated `FracDelegationInstanceClient` app
   * spec (`INSTANCE_APP_SPEC.byteCode.approval`), so the version uploaded matches this build.
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

    // Seed the registry's account: covers base MBR + 1 approval box (~3.3 ALGO at 8KB).
    const fundingAlgos = BigInt(initialFundingAlgos ?? 10n)
    await algorand.send.payment({
      sender: deployer.sender,
      receiver: appClient.appAddress,
      amount: fundingAlgos.algo(),
    })

    if (!INSTANCE_APP_SPEC.byteCode?.approval) {
      throw new Error(
        'FracDelegationInstance approval bytecode is not available. Was the generated client built with minimal build options?',
      )
    }
    const bytecode = Buffer.from(INSTANCE_APP_SPEC.byteCode.approval, 'base64')

    const sdk = new FracDelegationRegistrySDK({
      algorand,
      registryAppId: appClient.appId,
      writerAccount: deployer,
    })

    await sdk.uploadInstanceApprovalProgram({ bytecode })

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
