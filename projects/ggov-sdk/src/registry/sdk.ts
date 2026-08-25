import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import {
  GGovRegistryClient,
  GGovRegistryFactory,
  APP_SPEC as REGISTRY_APP_SPEC,
} from '../generated/GGovRegistryClient.js'
import { APP_SPEC as PERIOD_APP_SPEC } from '../generated/GGovPeriodClient.js'
import {
  ConstructorArgs,
  AccountWithVotes,
  SenderWithSigner,
  GGovCommitteeFile,
  CommitteeId,
  CommonMethodBuilderArgs,
  GGovRegistryContractArgs,
  SendResult,
} from './types.js'
import { requireWriterWithClient } from '../util/requiresSender.js'
import { calculateCommitteeId, committeeIdToRaw } from '../util/comitteeId.js'
import { govToTuple } from './gov.js'
import { GGovRegistryReaderSDK } from './sdkReader.js'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors.js'
import { createTxnExecutor } from '../util/txnExecutor.js'
import { chunk } from '../util/chunk.js'
import { padForRefSlots } from '../util/padForRefSlots.js'
import { extraProgramPages } from '../util/extraProgramPages.js'
import { boxIoRefsFor, boxIoRefsPerCall, splitApprovalPages } from '../util/approvalPages.js'
import { feeFromGroupUsage, minFeeMicroAlgos } from '../util/groupUsageFee.js'
import { PERIOD_APPROVAL_BOX_NAME } from '../util/boxNames.js'
import { noteNonce } from '../util/noteNonce.js'
import { AppSizeParams, hasAppSizeChange, sendAppSizeUpdate } from '../util/appSizeUpdate.js'
import {
  DEFAULT_PERIOD_MBR_MICROALGOS,
  MAX_ESCROWS_PER_FD_IMPORT,
  UPLOAD_APPROVAL_MAX_FEE_MICROALGOS,
} from '../constants.js'

export class GGovRegistrySDK extends GGovRegistryReaderSDK {
  public writerAccount?: SenderWithSigner
  public writeClient?: GGovRegistryClient

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest)
    if (writerAccount) {
      this.writerAccount = writerAccount
      this.writeClient = new GGovRegistryClient({
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

  @requireWriterWithClient()
  @wrapErrors()
  async uploadCommitteeFile(committeeFile: GGovCommitteeFile): Promise<Uint8Array> {
    const committeeId = calculateCommitteeId(JSON.stringify(committeeFile))
    const committeeMetadata = await this.getCommitteeMetadata(committeeId)
    if (!committeeMetadata) {
      if (this.debug) console.log('Registering committee...')
      const { registryId: xGovRegistryId, ...rest } = committeeFile
      const { txIds } = await this.registerCommittee({ committeeId, xGovRegistryId, ...rest })
      if (this.debug) console.log('Committee registered ', ...txIds)
    }
    const accounts = committeeFile.govs.map(({ address }) => address)
    const votesByAddress = new Map<string, number>()
    for (const { address, votes } of committeeFile.govs) {
      if (!votesByAddress.has(address)) votesByAddress.set(address, votes)
    }
    const [accountIds, lastIngestedGov] = await Promise.all([
      this.getAccountIdMap(accounts),
      this.getCommitteeSuperboxDataLast(committeeId),
    ])

    // order accounts, increasing IDs and zero IDs last
    const accountsInOrder = [...accountIds.entries()]
      .map(([address, id]) => ({ address, id }))
      .sort(({ id: a }, { id: b }) => (a === 0 && b !== 0 ? 1 : a !== 0 && b === 0 ? -1 : a - b))

    if (this.debug) console.log({ acctLen: accountsInOrder.length, lastIngestedGov })
    if (lastIngestedGov.total) {
      const expectedLastId = accountsInOrder[lastIngestedGov.total - 1].id
      if (lastIngestedGov.last && lastIngestedGov.last[0] !== expectedLastId) {
        throw new Error(`Last ingested gov ID ${lastIngestedGov.last[0]} does not match expected ID ${expectedLastId}`)
        // TODO get govs, compare with accountsInOrder, uningest as necessary, resume ingestion
      }
    }
    const accountsToIngest = accountsInOrder.slice(lastIngestedGov.total ? lastIngestedGov.total : 0)
    const chunks = chunk(accountsToIngest, 120)
    if (this.debug) console.log(`Ingesting ${accountsToIngest.length} govs in ${chunks.length} chunks...`)
    for (const accountsChunk of chunks) {
      const govs = accountsChunk.map(({ id, address }) => ({
        accountId: id,
        account: address,
        votes: votesByAddress.get(address)!,
      }))
      const { txIds } = await this.ingestGovs({ committeeId, govs })
      const accountsLog = accountsChunk.map(({ address }) => address.slice(0, 8) + '..').join(' ')
      if (this.debug) console.log('gov ingested ', accountsLog, txIds[txIds.length - 1])
    }
    return committeeId
  }

  @requireWriterWithClient()
  @wrapErrors()
  makeRegisterCommitteeTxns({
    committeeId,
    periodStart,
    periodEnd,
    totalMembers,
    totalVotes,
    xGovRegistryId,
    builder,
  }: Omit<
    GGovRegistryContractArgs['registerCommittee(byte[32],uint32,uint32,uint32,uint32,uint64)void'],
    'committeeId'
  > & { committeeId: CommitteeId } & CommonMethodBuilderArgs) {
    const committeeRaw = committeeIdToRaw(committeeId)
    const { sender, signer } = this.writerAccount!
    builder = builder ?? this.writeClient!.newGroup()
    return builder.registerCommittee({
      args: { committeeId: committeeRaw, periodStart, periodEnd, totalMembers, totalVotes, xGovRegistryId },
      sender,
      signer,
    })
  }

  registerCommittee = this.makeTxnExecutor({
    maker: this.makeRegisterCommitteeTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeUnregisterCommitteeTxns({ committeeId, builder }: { committeeId: CommitteeId } & CommonMethodBuilderArgs) {
    const committeeRaw = committeeIdToRaw(committeeId)
    const { sender, signer } = this.writerAccount!
    builder = builder ?? this.writeClient!.newGroup()
    return builder.unregisterCommittee({
      args: { committeeId: committeeRaw },
      sender,
      signer,
    })
  }

  unregisterCommittee = this.makeTxnExecutor({
    maker: this.makeUnregisterCommitteeTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeIngestGovsTxns({
    committeeId,
    govs,
    builder,
  }: { committeeId: CommitteeId; govs: AccountWithVotes[] } & CommonMethodBuilderArgs) {
    const { sender, signer } = this.writerAccount!
    const committeeRaw = committeeIdToRaw(committeeId)
    builder = builder ?? this.writeClient!.newGroup()
    const govChunks = chunk(govs, 8)
    if (govChunks.length > 15) {
      throw new Error(`Too many govs to ingest in one transaction group: ${govs.length} (max 120)`)
    }
    for (const govs of govChunks)
      builder = builder.ingestGovs({
        args: { committeeId: committeeRaw, govs: govs.map(govToTuple) },
        sender,
        signer,
      })
    return builder
  }

  ingestGovs = this.makeTxnExecutor({
    maker: this.makeIngestGovsTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetXGovRegistryAppTxns({
    appId,
    builder,
  }: GGovRegistryContractArgs['setXGovRegistryApp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setXGovRegistryApp({ args: { appId } })
    return builder
  }

  setXGovRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetXGovRegistryAppTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetFracRegistryAppTxns({
    appId,
    builder,
  }: GGovRegistryContractArgs['setFracRegistryApp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setFracRegistryApp({ args: { appId } })
    return builder
  }

  setFracRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetFracRegistryAppTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetMBRTopUpTxns({
    amount,
    builder,
  }: GGovRegistryContractArgs['setMBRTopUp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setMbrTopUp({ args: { amount } })
    return builder
  }

  setMBRTopUp = this.makeTxnExecutor({
    maker: this.makeSetMBRTopUpTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetOperatorTxns({
    account,
    builder,
  }: GGovRegistryContractArgs['setOperator(address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setOperator({ args: { account } })
    return builder
  }

  setOperator = this.makeTxnExecutor({
    maker: this.makeSetOperatorTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetLastPeriodIdTxns({
    newLastPeriodId,
    builder,
  }: GGovRegistryContractArgs['setLastPeriodId(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // A downward move reads the period boxes in the reclaimed range; AlgoKit populates the
    // box references automatically. A forward seed (the legacy case) reads no boxes.
    builder = builder.setLastPeriodId({ args: { newLastPeriodId } })
    return builder
  }

  setLastPeriodId = this.makeTxnExecutor({
    maker: this.makeSetLastPeriodIdTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeSetAdminTxns({ newAdmin, builder }: GGovRegistryContractArgs['setAdmin(address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setAdmin({ args: { newAdmin } })
    return builder
  }

  setAdmin = this.makeTxnExecutor({
    maker: this.makeSetAdminTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeWithdrawALGOTxns({
    receiver,
    amount,
    builder,
  }: GGovRegistryContractArgs['withdrawALGO(address,uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // extraFee covers the single inner payment
    builder = builder.withdrawAlgo({ args: { receiver, amount }, extraFee: (1000).microAlgo() })
    return builder
  }

  withdrawALGO = this.makeTxnExecutor({
    maker: this.makeWithdrawALGOTxns,
  })

  /**
   * Update the `GGovRegistry` app's program to the build exported by this `ggov-sdk`  version.
   * Admin-only. The write client compiles the current approval/clear programs from its embedded
   * app spec, so the on-chain code is replaced with the version bundled here.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeUpdateApplicationTxns({ note, builder }: CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.update.bare({ note })
    return builder
  }

  private updateApplicationCode = this.makeTxnExecutor({
    maker: this.makeUpdateApplicationTxns,
  })

  /**
   * Update the `GGovRegistry` app's program, optionally resizing its global schema and extra
   * program pages in the same transaction.
   *
   * The registry no longer declares a padded `stateTotals`, so its schema is whatever
   * `GGovRegistryContract` infers — which means a build that adds global state needs the deployed
   * registry grown to match. `factory.deploy` cannot do that: it classifies "existing app has fewer
   * slots than needed" as a schema break whose only remedies are failing or creating a *new* app,
   * and its update transaction carries no schema fields at all. So a resize is sent outside the
   * composer by {@link sendAppSizeUpdate}. Without `size` this is the ordinary code update.
   *
   * Admin-only. On a resize the admin becomes the app's `sizeSponsor` and takes on the registry's
   * whole schema + extra-page MBR — not just the delta.
   */
  updateApplication = async (
    args: { size?: AppSizeParams; note?: string } = {},
  ): Promise<SendResult | { txId: string }> => {
    const { size, note } = args
    if (!hasAppSizeChange(size)) return this.updateApplicationCode({ note })
    if (!this.writerAccount) throw new Error('writerAccount not set on the SDK instance')
    const byteCode = this.writeClient!.appClient.appSpec.byteCode
    return sendAppSizeUpdate({
      algorand: this.algorand,
      appId: this.appId,
      account: this.writerAccount,
      size,
      approvalProgram: byteCode ? Buffer.from(byteCode.approval, 'base64') : undefined,
      clearStateProgram: byteCode ? Buffer.from(byteCode.clear, 'base64') : undefined,
      note,
    })
  }

  /**
   * Delete the `GGovRegistry` app. Admin-only.
   *
   * WARNING: unlike {@link GGovSDK.deletePeriodApp}, this does NOT return the app's balance or
   * clean up its boxes — the contract's `deleteApplication` is just an admin check, nothing else.
   * The whole balance (base MBR, any boxes' MBR, plus any other funds) becomes permanently unreachable
   * once the app is deleted, and any live delegations or period summaries are orphaned. See contract's
   * `deleteApplication` baremethod for details.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeDeleteApplicationTxns({ note, builder }: CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.delete.bare({ note })
    return builder
  }

  /**
   * Delete the `GGovRegistry` app. Admin-only.
   *
   * See {@link makeDeleteApplicationTxns} for important admin/MBR-recovery caveats.
   */
  deleteApplication = this.makeTxnExecutor({
    maker: this.makeDeleteApplicationTxns,
  })

  @requireWriterWithClient()
  @wrapErrors()
  makeUningestGovsTxns({
    committeeId,
    govs,
    builder,
  }: Omit<GGovRegistryContractArgs['uningestGovs(byte[32],address[])void'], 'committeeId'> & {
    committeeId: CommitteeId
  } & CommonMethodBuilderArgs) {
    const { sender, signer } = this.writerAccount!
    const committeeRaw = committeeIdToRaw(committeeId)
    builder = builder ?? this.writeClient!.newGroup()
    return builder.uningestGovs({
      args: { committeeId: committeeRaw, govs },
      sender,
      signer,
    })
  }

  uningestGovs = this.makeTxnExecutor({
    maker: this.makeUningestGovsTxns,
  })

  /**
   * Uningest govs from a committee in reverse ingestion order.
   * Looks up each account's committee offset, sorts descending, and sends sequentially.
   * @param committeeId Committee ID
   * @param accounts Accounts to uningest (in any order - will be sorted internally)
   */
  @requireWriterWithClient()
  @wrapErrors()
  async uningestCommitteeGovs({
    committeeId,
    accounts,
  }: {
    committeeId: CommitteeId
    accounts: string[]
  }): Promise<void> {
    const metadata = await this.getCommitteeMetadata(committeeId)
    if (!metadata) throw new Error('Committee not found')
    const numericId = metadata.numericId

    const gGovAccountsMap = await this.getGGovAccountsMap(accounts)

    // sort by committee offset descending (reverse ingestion order)
    const sorted = accounts
      .map((address) => {
        const gGovAccount = gGovAccountsMap.get(address)
        if (!gGovAccount || gGovAccount.accountId === 0) {
          throw new Error(`Account ${address} not found in gGov registry`)
        }
        const offsetEntry = gGovAccount.committeeOffsets.find(([cId]) => cId === numericId)
        if (!offsetEntry) {
          throw new Error(`Account ${address} has no offset for committee numericId ${numericId}`)
        }
        return { address, offset: offsetEntry[1] }
      })
      .sort((a, b) => b.offset - a.offset)

    // send sequentially in chunks - strict reverse order required
    const chunks = chunk(sorted, 8)
    for (const accountsChunk of chunks) {
      await this.uningestGovs({ committeeId, govs: accountsChunk.map(({ address }) => address) })
      if (this.debug)
        console.log('Uningest chunk:', accountsChunk.map(({ address }) => address.slice(0, 8) + '..').join(' '))
    }
  }

  // ── Delegation ───────────────────────────────────────────────────

  @requireWriterWithClient()
  @wrapErrors()
  makeMirrorXGovDelegationTxns({
    account,
    note,
    builder,
  }: GGovRegistryContractArgs['mirrorXGovDelegation(address)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    return builder.mirrorXGovDelegation({ args: { account }, note, extraFee: (1000).microAlgo() })
  }

  mirrorXGovDelegation = this.makeTxnExecutor({ maker: this.makeMirrorXGovDelegationTxns })

  /**
   * Delegate a batch of escrow accounts to the frac instance each is registered to, so that instance
   * can cast pooled gGov votes on their behalf. Admin only.
   *
   * Fail-loud: an escrow that is not a registered gGov account, or not registered to any frac
   * instance, rejects the whole call. Unlike `mirrorXGovDelegation` this OVERWRITES an existing
   * delegation; re-importing an unchanged delegation is a contract-level no-op.
   *
   * One group per call — use {@link importFracDelegationsAll} to import more than {@link MAX_ESCROWS_PER_FD_IMPORT}
   * escrow delegations.
   *
   * The registry app account pays the delegation box MBR and no payment is attached — fund it
   * first, sized by `DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS` and `DELEGATION_MBR_EXISTING_DELEGATEE_MICROALGOS`.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeImportFracDelegationsTxns({
    escrowAccounts,
    note,
    builder,
  }: GGovRegistryContractArgs['importFracDelegations(address[])void'] & CommonMethodBuilderArgs) {
    if (escrowAccounts.length > MAX_ESCROWS_PER_FD_IMPORT) {
      throw new Error(
        `Too many escrows to import in one transaction group: ${escrowAccounts.length} (max ${MAX_ESCROWS_PER_FD_IMPORT}). Use \`importFracDelegationsAll\` method.`,
      )
    }
    builder = builder ?? this.writeClient!.newGroup()
    // Slots: 7 per escrow, maximized case (every escrow on a distinct instance and already delegated elsewhere) —
    // this registry's `accounts` (1) + `delegations` (2) boxes; its `reverseDelegations` box keyed by the
    // previous delegatee (3) (unlinked) AND a second one keyed by the instance (4) (linked; the map is keyed by
    // delegatee, so a re-delegation touches two entries); the frac registry's `escrows` (5) + `instances` (6) boxes
    // read by the inner `getEscrow`, and the instance app ref (`Application(id).address` needs the app available).
    // Plus a fixed 1 for the frac registry app ref, which the whole batch shares.
    builder = padForRefSlots(builder, escrowAccounts.length * 7 + 1, 'importFracDelegations')
    // extraFee covers one inner getEscrow call per escrow sent as argument
    return builder.importFracDelegations({
      args: { escrowAccounts },
      note,
      extraFee: (escrowAccounts.length * 1000).microAlgo(),
    })
  }

  importFracDelegations = this.makeTxnExecutor({ maker: this.makeImportFracDelegationsTxns })

  /**
   * Import any number of frac escrows delegations, one transaction group per {@link MAX_ESCROWS_PER_FD_IMPORT}
   * chunk.
   *
   * Throws on the first failing group, leaving earlier chunks imported. Re-running the whole list
   * is safe and cheap: the contract treats an unchanged delegation as a no-op, so already-imported
   * escrows are skipped without side effects.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async importFracDelegationsAll({
    escrowAccounts,
    note,
  }: GGovRegistryContractArgs['importFracDelegations(address[])void'] & {
    note?: string | Uint8Array
  }): Promise<void> {
    for (const escrowsChunk of chunk(escrowAccounts, MAX_ESCROWS_PER_FD_IMPORT)) {
      const { txIds } = await this.importFracDelegations({ escrowAccounts: escrowsChunk, note })
      if (this.debug) console.log('escrows imported ', escrowsChunk.length, txIds[txIds.length - 1])
    }
  }

  /**
   * Set (or clear) an account's voting-power delegation. ABI-compatible with the xGov registry's
   * `set_voting_account`:
   *  - delegate: `setVotingAccount({ votingAddress })`
   *  - clear (vote for self): `setVotingAccount({})` (omitting `votingAddress`)
   *  - manage another account (as its current delegatee): `setVotingAccount({ account, votingAddress })`
   *
   * `account` defaults to the signer (self); `votingAddress` defaults to `account` (clear).
   *
   * The delegator may be a gGov account or a fractional-delegation account — this registry is the
   * single source of truth for both. A gGov delegator is settled by a box read and needs no extra
   * fee; only a delegator absent from the gGov `accounts` box falls through to a readonly inner call
   * to the frac registry, so that call's fee is opt-in via `fractionalOnly`. Set it when the
   * delegator is known to hold AlgoQuarters but no gGov committee membership — omitting it there
   * fails the group on fee, and setting it for a gGov delegator merely overpays by 0.001 ALGO.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeSetVotingAccountTxns({
    votingAddress,
    account,
    fractionalOnly = false,
    note,
    sender,
    builder,
  }: { votingAddress?: string; account?: string; fractionalOnly?: boolean } & CommonMethodBuilderArgs & {
      sender?: string
    }) {
    builder = builder ?? this.writeClient!.newGroup()
    const self = sender ?? String(this.writerAccount!.sender)
    const govAddress = account ?? self
    const target = votingAddress ?? govAddress // omitted target == clear ("vote for self")
    const opts: any = {
      args: { govAddress, votingAddress: target },
      note,
      // The frac fallback fires on the delegator, whichever way this call is going: clearing runs the
      // same gate as delegating, so a frac-only account pays it to undelegate too.
      ...(fractionalOnly ? { extraFee: (1000).microAlgo() } : {}),
    }
    if (sender) {
      opts.sender = sender
      opts.signer = this.algorand.account.getSigner(sender)
    }
    return builder.setVotingAccount(opts)
  }

  setVotingAccount = this.makeTxnExecutor({ maker: this.makeSetVotingAccountTxns })

  // ── Period bytecode upload (admin-only) ──────────────────────────
  // The registry's approval-bytecode box key, as raw bytes ('Pap').

  @requireWriterWithClient()
  @wrapErrors()
  makeUploadPeriodApprovalTxns({
    page1,
    page2,
    page3,
    staticFee,
    note,
    builder,
  }: { staticFee?: number } & GGovRegistryContractArgs['uploadPeriodApproval(byte[],byte[],byte[])void'] &
    CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    const totalBytes = page1.length + page2.length + page3.length
    // Creating and filling a box of N bytes costs N of box-write budget, and each box reference
    // buys BOX_IO_BYTES_PER_REF of it. Resource population only adds one reference per distinct
    // box, which covers a 1024-byte write and no more, so the budget is bought explicitly here.
    // A three-page program needs 12 references, past the 8 MAX_APP_CALL_FOREIGN_REFERENCES allows
    // on one call, so the surplus rides on no-op increaseBudget calls: box I/O budget is pooled
    // across the group, and a call to this same app can carry references to its boxes without
    // touching them.
    const [ownRefs, ...padRefs] = boxIoRefsPerCall(boxIoRefsFor(totalBytes), 'uploadPeriodApproval')
    for (let i = 0; i < padRefs.length; i++) {
      builder = builder.increaseBudget({
        args: { itxns: 0 },
        boxReferences: Array.from({ length: padRefs[i] }, () => PERIOD_APPROVAL_BOX_NAME),
        // Distinct notes: otherwise identical pads would collide into one duplicate txn ID.
        note: `pap-refs-${i}-${noteNonce()}`,
      })
    }
    return builder.uploadPeriodApproval({
      args: { page1, page2, page3 },
      boxReferences: Array.from({ length: ownRefs }, () => PERIOD_APPROVAL_BOX_NAME),
      // Under AVM v13 the fee is usage-based across the group, and ~8KB of app args pushes usage past
      // the free allowance, so the flat minimum is rejected. See feeFromGroupUsage: the caller
      // simulates once to learn the real requirement and passes it back in as staticFee.
      staticFee: (staticFee ?? UPLOAD_APPROVAL_MAX_FEE_MICROALGOS).microAlgo(),
      note,
    })
  }

  uploadPeriodApproval = this.makeTxnExecutor({
    maker: this.makeUploadPeriodApprovalTxns,
  })

  /**
   * Upload the full GGovPeriod approval bytecode in a single call.
   *
   * Was a loop of 2000-byte chunks across groups of up to 16 transactions, because total application
   * arguments were capped at 2KB. AVM v13 raised that to 16KB, and an AVM bytes value still caps at
   * 4096, so the program goes up as the same three pages the contract stores and reads back.
   *
   * Past two pages the write also outgrows the box I/O budget one app call can buy, so the call
   * picks up reference-carrying companions — see {@link makeUploadPeriodApprovalTxns}.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async uploadPeriodApprovalProgram({
    bytecode,
    note,
  }: {
    bytecode: Uint8Array
    note?: string | Uint8Array
  }): Promise<void> {
    // Distinct default note per call: re-uploading identical bytecode (a redeploy, or a test
    // restoring the real program) would otherwise reproduce a byte-identical txn, which the node
    // rejects as already-in-ledger while the earlier one is inside its validity window.
    note = note ?? `pap-upload-${noteNonce()}`
    const { page1, page2, page3 } = splitApprovalPages(bytecode)
    // Two round trips on purpose. Simulate must run with a fee that already passes the v13 usage
    // check, so the probe goes out at UPLOAD_APPROVAL_MAX_FEE_MICROALGOS; the real send then pays
    // exactly what the network asked for.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const probe = await this.makeUploadPeriodApprovalTxns({ page1, page2, page3, note })
    const simulated = await probe.simulate({ skipSignatures: true })
    const fee = feeFromGroupUsage(simulated.simulateResponse, await minFeeMicroAlgos(this.algorand.client.algod))

    await this.uploadPeriodApproval({ page1, page2, page3, staticFee: Number(fee), note })
  }

  // ── addPeriod (paired payment + createPeriod) ────────────────────

  /**
   * Reference slots the group calling `createPeriod` must carry for it to read the approval box.
   *
   * The child's whole bytecode is read back out of the box at create time, and box I/O budget is
   * {@link BOX_IO_BYTES_PER_REF} per reference pooled across the group — so a program past what
   * one app call's {@link MAX_APP_CALL_FOREIGN_REFERENCES} slots can buy needs company in the
   * group. The extra slot covers the small boxes the same call also touches.
   *
   * Sized from the box rather than the GGovPeriod built into this SDK: the box is what is being
   * deployed, and it exists precisely so child code can be upgraded without redeploying the
   * registry. A missing box costs no padding — the contract raises its own not-configured error.
   */
  private async approvalReadRefSlots(): Promise<number> {
    try {
      const box = await this.algorand.app.getBoxValue(this.appId, PERIOD_APPROVAL_BOX_NAME)
      return boxIoRefsFor(box.length) + 1
    } catch {
      return 0
    }
  }

  @requireWriterWithClient()
  @wrapErrors()
  async makeAddPeriodTxns({
    committeeId,
    votingStart,
    votingEnd,
    mbrAmount,
    note,
    builder,
  }: Omit<
    GGovRegistryContractArgs['createPeriod(byte[32],uint64,uint64,pay)(uint32,uint64)'],
    'committeeId' | 'mbrPayment'
  > & {
    committeeId: CommitteeId
    mbrAmount?: bigint | number
  } & CommonMethodBuilderArgs) {
    const writer = this.writerAccount!
    const mbr = BigInt(mbrAmount ?? DEFAULT_PERIOD_MBR_MICROALGOS)
    const mbrPayment = await this.algorand.createTransaction.payment({
      sender: writer.sender,
      receiver: this.writeClient!.appAddress,
      amount: { microAlgo: mbr } as any,
    } as any)
    builder = builder ?? this.writeClient!.newGroup()
    builder = padForRefSlots(builder, await this.approvalReadRefSlots(), 'createPeriod')
    return builder.createPeriod({
      args: {
        committeeId: committeeIdToRaw(committeeId),
        votingStart,
        votingEnd,
        mbrPayment,
      },
      note,
      extraFee: (3000).microAlgo(),
    })
  }

  addPeriod = this.makeTxnExecutor<typeof this.makeAddPeriodTxns, bigint>({
    maker: this.makeAddPeriodTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? []
      const tup = returns[returns.length - 1] ?? returns[0]
      return BigInt(Array.isArray(tup) ? tup[0] : tup)
    },
  })

  // ── Bootstrap: deploy + fund + upload period bytecode + optional setup ──

  /**
   * Deploy a fresh `GGovRegistry` app, seed its MBR, upload the GGovPeriod approval bytecode
   * into the registry's approval box, and optionally configure the xGov registry app id, the
   * frac-delegation registry app id, and the operator account. Returns the writer-enabled
   * registry SDK bound to the new app.
   *
   * The period approval bytecode comes from the generated `GGovPeriodClient` app spec
   * (`PERIOD_APP_SPEC.byteCode.approval`), so the version uploaded matches this build.
   */
  static async createRegistry({
    algorand,
    deployer,
    operatorAccount,
    xGovRegistryAppId,
    fracRegistryAppId,
    initialFundingAlgos,
    firstPeriodId,
    update = false,
  }: {
    algorand: AlgorandClient
    deployer: SenderWithSigner
    operatorAccount?: string | Address
    xGovRegistryAppId?: bigint | number
    fracRegistryAppId?: bigint | number
    initialFundingAlgos?: bigint | number
    /**
     * Id to assign to the first period created on this registry. Use to continue numbering
     * contiguously after a legacy system (e.g. 16 to follow legacy periods 1..15). Seeds the
     * registry's period counter to firstPeriodId - 1; omit to start at 1.
     */
    firstPeriodId?: bigint | number
    update?: boolean
  }): Promise<{ sdk: GGovRegistrySDK; appClient: GGovRegistryClient }> {
    const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
      defaultSender: deployer.sender,
      defaultSigner: deployer.signer,
    })
    const { appClient } = await factory.deploy({
      onUpdate: update ? 'update' : 'append',
      onSchemaBreak: update ? 'fail' : 'append',
      createParams: {
        // Sized from the compiled program rather than pinned at the old AVM maximum, plus ONE spare
        // page. Sized exactly, GGovRegistry would get a 6144-byte ceiling for a ~5.6KB program, which
        // is tighter than the 3 pages it used to carry — and adding pages later is the one thing
        // `factory.deploy` cannot do: it treats "existing pages < needed" as a schema break whose
        // only remedies are failing or creating a NEW app. So without the spare page, the next time
        // the program crossed that ceiling a routine `createRegistry({ update: true })` would start
        // failing with "Schema break detected". 100k µAlgo once per registry removes that trap.
        // (Spawned period/instance apps need no such margin: the registry sizes each one from the
        // bytecode in its approval box at every create.)
        extraProgramPages:
          extraProgramPages(
            Buffer.from(REGISTRY_APP_SPEC.byteCode!.approval, 'base64'),
            Buffer.from(REGISTRY_APP_SPEC.byteCode!.clear, 'base64'),
          ) + 1,
      },
    })

    // Seed the registry's account: covers base MBR + 1 approval box (~3.3 ALGO at 8KB).
    const fundingAlgos = BigInt(initialFundingAlgos ?? 10n)
    await algorand.send.payment({
      sender: deployer.sender,
      receiver: appClient.appAddress,
      amount: fundingAlgos.algo(),
    })

    if (!PERIOD_APP_SPEC.byteCode?.approval) {
      throw new Error(
        'GGovPeriod approval bytecode is not available. Was the generated client built with minimal build options?',
      )
    }
    const bytecode = Buffer.from(PERIOD_APP_SPEC.byteCode.approval, 'base64')

    const sdk = new GGovRegistrySDK({
      algorand,
      registryAppId: appClient.appId,
      writerAccount: deployer,
    })

    await sdk.uploadPeriodApprovalProgram({ bytecode })

    if (firstPeriodId !== undefined) {
      // Seed the counter so the first createPeriod issues firstPeriodId. Done before setOperator,
      // and the operator is the only role that can create periods, so no period can be created
      // in between.
      await sdk.setLastPeriodId({ newLastPeriodId: BigInt(firstPeriodId) - 1n })
    }

    if (xGovRegistryAppId !== undefined) {
      await sdk.setXGovRegistryApp({ appId: BigInt(xGovRegistryAppId) })
    }
    if (fracRegistryAppId !== undefined) {
      await sdk.setFracRegistryApp({ appId: BigInt(fracRegistryAppId) })
    }
    if (operatorAccount !== undefined) {
      const op = typeof operatorAccount === 'string' ? operatorAccount : operatorAccount.toString()
      await sdk.setOperator({ account: op })
    }

    return { sdk, appClient }
  }
}
