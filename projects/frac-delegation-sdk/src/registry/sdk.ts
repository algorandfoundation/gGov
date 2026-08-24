import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import {
  FracDelegationRegistryClient,
  FracDelegationRegistryComposer,
  FracDelegationRegistryFactory,
} from '../generated/FracDelegationRegistryClient.js'
import {
  FracDelegationInstanceClient,
  APP_SPEC as INSTANCE_APP_SPEC,
} from '../generated/FracDelegationInstanceClient.js'
import {
  ConstructorArgs,
  SenderWithSigner,
  CommonMethodBuilderArgs,
  FracDelegationRegistryContractArgs,
} from './types.js'
import { requireWriterWithClient } from '../util/requiresSender.js'
import { FracDelegationRegistryReaderSDK } from './sdkReader.js'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors.js'
import { createTxnExecutor } from '../util/txnExecutor.js'
import { chunk } from '../util/chunk.js'
import { noteNonce } from '../util/noteNonce.js'
import {
  BODY_CHUNK_BYTES,
  DEFAULT_INSTANCE_MBR_MICROALGOS,
  MAX_ESCROWS_PER_REGISTER_GROUP,
  MAX_GROUP_SIZE,
} from '../constants.js'

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
  makeSetMBRTopUpTxns({
    amount,
    builder,
  }: FracDelegationRegistryContractArgs['setMBRTopUp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setMbrTopUp({ args: { amount } })
    return builder
  }

  setMBRTopUp = this.makeTxnExecutor({
    maker: this.makeSetMBRTopUpTxns,
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

  // ── Admin: escrows ───────────────────────────────────────────────

  /**
   * Register `account` as an escrow of instance `instanceNumId`. Admin only.
   *
   * Records the globally-unique escrow -> instance assignment in the registry, bumps the
   * instance's `numEscrows` counter, and inner-calls the instance's `registerEscrow` so the
   * account is appended to the instance's own escrows list. Rejects with `ERR:FE_AS` if the
   * account is already assigned to any instance. The registry's own boxes, the target instance
   * app, and its escrows box are resolved automatically via resource population.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeRegisterEscrowTxns({
    instanceNumId,
    account,
    note,
    builder,
  }: FracDelegationRegistryContractArgs['registerEscrow(uint16,address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // extraFee covers the single inner app call to the instance's registerEscrow.
    return builder.registerEscrow({ args: { instanceNumId, account }, note, extraFee: (1000).microAlgo() })
  }

  registerEscrow = this.makeTxnExecutor({
    maker: this.makeRegisterEscrowTxns,
  })

  /**
   * Register several escrows to the same instance `instanceNumId` in one atomic group. Admin only.
   *
   * Per account this is exactly {@link registerEscrow}; what the group buys is atomicity. The
   * instance's own `escrows` box is read and rewritten one entry longer by every call, so separate
   * concurrent calls would each size their box budget against the same pre-state and the later ones
   * could execute against a box that has since grown. Inside one group the calls are ordered, and
   * resource population sees the whole sequence.
   *
   * Capped at {@link MAX_ESCROWS_PER_REGISTER_GROUP} accounts — see the constant for the box-I/O
   * reasoning behind the number. Use {@link registerEscrowsAll} for a longer list.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeRegisterEscrowsTxns({
    instanceNumId,
    accounts,
    note,
    builder,
  }: {
    instanceNumId: bigint | number
    accounts: string[]
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    if (accounts.length === 0) throw new Error('registerEscrows: no accounts to register')
    if (accounts.length > MAX_ESCROWS_PER_REGISTER_GROUP) {
      throw new Error(
        `registerEscrows: ${accounts.length} accounts exceeds the ${MAX_ESCROWS_PER_REGISTER_GROUP} per group — ` +
          `chunk them, or use registerEscrowsAll.`,
      )
    }
    for (const account of accounts) {
      // extraFee covers this call's single inner app call to the instance's registerEscrow.
      builder = builder.registerEscrow({ args: { instanceNumId, account }, note, extraFee: (1000).microAlgo() })
    }
    return builder
  }

  registerEscrows = this.makeTxnExecutor({
    maker: this.makeRegisterEscrowsTxns,
  })

  /**
   * Register every account in `accounts` as an escrow of instance `instanceNumId`, one group per
   * {@link MAX_ESCROWS_PER_REGISTER_GROUP}. Sequential: each group is atomic on its own, so a
   * failure part-way leaves the earlier groups registered — re-run with the remainder, which is safe
   * because an already-assigned escrow is rejected with `ERR:FE_AS` rather than registered twice.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async registerEscrowsAll({
    instanceNumId,
    accounts,
    note,
  }: {
    instanceNumId: bigint | number
    accounts: string[]
    note?: string | Uint8Array
  }) {
    for (const batch of chunk(accounts, MAX_ESCROWS_PER_REGISTER_GROUP)) {
      await this.registerEscrows({ instanceNumId, accounts: batch, note })
    }
  }

  // ── Admin: lifecycle ────────────────────────────────────────────

  /**
   * Update the `FracDelegationRegistry` app's program to the build exported by this
   * `frac-delegation-sdk` version. Admin-only. The write client compiles the current
   * approval/clear programs from its embedded app spec, so the on-chain code is replaced
   * with the version bundled here.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeUpdateApplicationTxns({ note, builder }: CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.update.bare({ note })
    return builder
  }

  updateApplication = this.makeTxnExecutor({
    maker: this.makeUpdateApplicationTxns,
  })

  /**
   * Delete the `FracDelegationRegistry` app. Admin-only. Refuses if any existing recorded
   * instance is still bound to this registry (instance.registryApp === this registry's appId).
   * Rebind (setRegistryApp) or delete those instances first.
   *
   * WARNING: does NOT return the app's balance or clean up its boxes — the whole balance
   * (base MBR, any boxes' MBR, plus any other funds) becomes permanently unreachable once
   * the app is deleted. See contract's `deleteApplication` baremethod for details.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async makeDeleteApplicationTxns({ note, builder }: CommonMethodBuilderArgs) {
    const existingInstances = await this.getExistingInstances()
    const boundInstanceIds = (
      await Promise.all(
        [...existingInstances].map(async ([id, instance]) => {
          const client = new FracDelegationInstanceClient({ algorand: this.algorand, appId: BigInt(instance.appId) })
          return BigInt((await client.state.global.registryApp())!) === this.appId ? id : null
        }),
      )
    ).filter((id) => id !== null)
    if (boundInstanceIds.length > 0) {
      throw new Error(
        `Cannot delete registry ${this.appId}: instance(s) ${boundInstanceIds.join(', ')} are still bound to it. Rebind (setRegistryApp) or delete them first.`,
      )
    }

    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.delete.bare({ note })
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
    // Distinct default note per call: re-uploading bytecode already uploaded (a redeploy, or a
    // test restoring the real program) otherwise reproduces byte-identical chunk txns, which the
    // node rejects as already-in-ledger while the earlier ones are inside their validity window.
    note = note ?? `iap-upload-${noteNonce()}`
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
  }: Omit<FracDelegationRegistryContractArgs['createInstance(string,pay)(uint16,uint64)'], 'mbrPayment'> & {
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
