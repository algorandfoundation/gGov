import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { getApplicationAddress } from 'algosdk'
import { FracDelegationRegistrySDK, SendResult, executeTxns } from '../registry/index.js'
import { FracCommitteeAq, FracDelegationInstanceClient } from '../generated/FracDelegationInstanceClient.js'
import {
  AlgoQuartersFile,
  ConstructorArgs,
  SenderWithSigner,
  InstanceMethodBuilderArgs,
  FracDelegationInstanceContractArgs,
} from './types.js'
import { requireWriter } from '../util/requiresSender.js'
import { FracDelegationReaderSDK } from './sdkReader.js'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors.js'
import { parseAqFile } from '../util/aqFile.js'
import { getSpendableBalance } from 'sdk-shared'
import { committeeIdToRaw } from '../util/comitteeId.js'
import { chunk } from '../util/chunk.js'
import { instanceBoxName, periodBoxName } from '../util/boxes.js'
import { flattenTopicVotes } from '../util/voteShapes.js'
import { AppSizeParams, hasAppSizeChange, sendAppSizeUpdate } from '../util/appSizeUpdate.js'
import {
  AQ_INSTANCE_MBR_PER_ACCOUNT_MICROALGOS,
  AQ_REGISTRY_MBR_PER_JOINING_ACCOUNT_MICROALGOS,
  AQ_REGISTRY_MBR_PER_NEW_ACCOUNT_MICROALGOS,
  MAX_ACCOUNTS_PER_INGEST_AQ,
  MAX_ACCOUNTS_PER_UNINGEST_AQ,
} from '../constants.js'

export class FracDelegationSDK extends FracDelegationReaderSDK {
  public writerAccount?: SenderWithSigner
  /** Composed registry SDK (writer-enabled). Reach registry writes/reads via `sdk.registry.X`. */
  declare public registry: FracDelegationRegistrySDK
  /** instanceNumId → cached writer client. */
  protected instanceWriteClientCache: Map<bigint, FracDelegationInstanceClient> = new Map()
  /** Cached gGov registry app id, read off the frac registry's `gGovRegistryApp` global. */
  protected gGovRegistryAppIdCache?: bigint

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

  /**
   * The configured gGov registry app id, or `0n` when the frac registry has none set. Admin-set and
   * effectively static, so a resolved id is memoised for this SDK's lifetime — same treatment as the
   * per-instance client cache. The `0n` sentinel is not cached: it is a misconfiguration, not a value.
   */
  protected async getGGovRegistryAppId(): Promise<bigint> {
    if (this.gGovRegistryAppIdCache) return this.gGovRegistryAppIdCache
    const appId = await this.registry.getGGovRegistryApp()
    if (appId) this.gGovRegistryAppIdCache = appId
    return appId
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

  // ── Registry passthroughs (end-user writes) ───────────────────────
  // The frac registry has no end-user writes today: every registry write is admin/bootstrap,
  // so nothing is forwarded here and they all stay on `this.registry`. Mirrors ggov, where
  // only the end-user setVotingAccount is forwarded; if a registry write an end user self-services
  // ever lands, forward it here the same way. The end-user READs are forwarded on FracDelegationReaderSDK
  // and inherited here.

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

  /**
   * Escrow count to size reference padding from — an upper bound, never an under-estimate.
   *
   * `syncPeriod` actually sizes against the committee snapshot rather than `escrows`, but `escrows`
   * is append-only and the snapshot is rebuilt from it, so `escrowsVotes.length <= escrows.length`
   * always holds. Over-padding costs one min fee per spare txn; under-padding fails the group.
   */
  private async escrowCountUpperBound(instanceNumId: bigint | number, readCache?: Map<string, unknown>) {
    // `getEscrows` is a simulate. The executor re-runs the maker while it sizes the group, so
    // without the cache a single write pays for this several times over.
    const key = `escrowCount:${instanceNumId}`
    const cached = readCache?.get(key)
    if (typeof cached === 'number') return cached
    const count = (await this.getEscrows(instanceNumId)).length
    readCache?.set(key, count)
    return count
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
   * The executor pads the group with no-op app calls to carry the per-escrow references — see
   * `sdk-shared`.
   */
  @requireWriter()
  @wrapErrors()
  async makeSyncCommitteeTxns({
    instanceNumId,
    committeeId,
    note,
    client,
    builder,
    readCache,
  }: Omit<FracDelegationInstanceContractArgs['syncCommittee(byte[32])(uint16,uint32[],uint32)'], 'committeeId'> & {
    instanceNumId: bigint | number
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    const numEscrows = await this.escrowCountUpperBound(instanceNumId, readCache)
    // Reference slots (N+7: one gGov registry box per escrow, plus 5 fixed boxes and 2 app refs)
    // are measured and padded for by the executor.
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

  // ── AlgoQuarters ─────────────────────────────────────────────────

  /**
   * Open (or re-open) the AlgoQuarters ledger for gGov committee `committeeId`. Operator only.
   *
   * `totalAq` and `totalAccounts` are the off-chain pipeline's declared totals for the committee's
   * period (`AlgoQuartersData.totalAlgoQuarters` and its account count); `ingestAq` accumulates
   * towards both and may never pass either, and the ledger only counts as complete once both are
   * reached. Both must be greater than zero. The committee must already be synced (`syncCommittee`) —
   * that snapshot is what supplies the `committeeNumId` every later call keys by.
   *
   * Re-runnable only while nothing has been ingested; afterwards the totals are frozen. Returns the
   * opened ledger, whose `committeeNumId` counterpart is on `getCommittee(committeeId)`.
   */
  @requireWriter()
  @wrapErrors()
  makeStartAqIngestTxns({
    instanceNumId: _instanceNumId,
    committeeId,
    totalAq,
    totalAccounts,
    note,
    client,
    builder,
  }: Omit<
    FracDelegationInstanceContractArgs['startAqIngest(byte[32],uint32,uint32)(uint32,uint32,uint32,uint32)'],
    'committeeId'
  > & {
    instanceNumId: bigint | number
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.startAqIngest({
      args: { committeeId: committeeIdToRaw(committeeId), totalAq, totalAccounts },
      note,
    })
  }

  startAqIngest = this.makeInstanceTxnExecutor({ maker: this.makeStartAqIngestTxns })

  /**
   * Ingest one batch of accounts' AlgoQuarters into committee `committeeNumId`. Operator only.
   *
   * Append-only per account: re-sending an account already ingested for this committee fails rather
   * than overwriting, so a replayed batch cannot double-count. Order does not matter.
   *
   * One group per call — use {@link ingestAqAll} to push a whole file. Both app accounts must be
   * funded first: the instance pays `AQ_INSTANCE_MBR_PER_ACCOUNT_MICROALGOS` of box MBR per account,
   * and the registry `AQ_REGISTRY_MBR_PER_NEW_ACCOUNT_MICROALGOS` per account it has never seen plus
   * `AQ_REGISTRY_MBR_PER_JOINING_ACCOUNT_MICROALGOS` per known account joining this instance for the
   * first time (see `constants.ts`). There is no funding path from the instance to the registry.
   */
  @requireWriter()
  @wrapErrors()
  makeIngestAqTxns({
    instanceNumId: _instanceNumId,
    committeeNumId,
    accountAqs,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['ingestAq(uint16,(address,uint32)[])void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    if (accountAqs.length === 0) throw new Error('ingestAq: no accounts to ingest')
    if (accountAqs.length > MAX_ACCOUNTS_PER_INGEST_AQ) {
      throw new Error(
        `ingestAq: ${accountAqs.length} accounts exceeds the ${MAX_ACCOUNTS_PER_INGEST_AQ} per call — ` +
          `chunk them, or use ingestAqAll.`,
      )
    }
    // Reference slots (2N+3: per account this instance's accountAq box and the registry's accounts
    // box, plus the registryApp ref, the registry's instances box and this instance's committeeAq
    // box) are measured and padded for by the executor.
    // extraFee covers one getOrCreateAccountWithInstance inner call per account. Those inner calls
    // each add 700 to the opcode pool, so the loop largely funds its own compute.
    return builder.ingestAq({
      args: { committeeNumId, accountAqs },
      note,
      extraFee: (accountAqs.length * 1000).microAlgo(),
    })
  }

  ingestAq = this.makeInstanceTxnExecutor({ maker: this.makeIngestAqTxns })

  /**
   * Ingest every entry of `accountAqs` into committee `committeeNumId`, one group per
   * {@link MAX_ACCOUNTS_PER_INGEST_AQ} accounts. Sequential: each group is atomic on its own, so a
   * failure part-way leaves earlier batches ingested — re-run with the remainder, which is safe
   * because an already-ingested account is rejected rather than double-counted.
   */
  @requireWriter()
  @wrapErrors()
  async ingestAqAll({
    instanceNumId,
    committeeNumId,
    accountAqs,
    note,
  }: FracDelegationInstanceContractArgs['ingestAq(uint16,(address,uint32)[])void'] & {
    instanceNumId: bigint | number
    note?: string
  }) {
    for (const batch of chunk(accountAqs, MAX_ACCOUNTS_PER_INGEST_AQ)) {
      await this.ingestAq({ instanceNumId, committeeNumId, accountAqs: batch, note })
    }
  }

  /**
   * Upload a whole AQ manifest (`AlgoQuartersFile`, the frac delegation pipeline's AQ output) into
   * committee `committeeId`'s ledger on instance `instanceNumId`. Operator only.
   *
   * End-to-end orchestration of the AQ primitives: validates the manifest client-side (totals,
   * uint32 bounds, duplicates, network genesis hash), syncs the committee if it has no local
   * snapshot yet, opens the ledger via `startAqIngest` (or corrects a still-pristine one), and
   * ingests in `MAX_ACCOUNTS_PER_INGEST_AQ` batches.
   *
   * Resumable and idempotent: already-ingested accounts are detected up front (`getAccountAqs`)
   * and skipped, so a run interrupted mid-way — each batch is atomic on its own — completes on
   * re-run, and re-running against a complete ledger is a no-op. Throws if the on-chain state
   * contradicts the manifest: a frozen ledger with different totals, an ingested account whose AQ
   * differs from its row, or ingested accounts the manifest does not contain.
   *
   * MBR is pre-checked before any ingest: the instance pays per ingested account and the registry
   * per never-seen account (see `AQ_*_MBR_*` constants), with no funding path between the apps.
   * On a shortfall this throws with the exact top-up per app account, unless `autoFund` is set,
   * in which case the writer tops up the shortfalls itself.
   * @returns The committee's numeric ID and the completed ledger
   */
  @requireWriter()
  @wrapErrors()
  async uploadAqFile({
    instanceNumId,
    committeeId,
    aqFile,
    autoFund = false,
    note,
  }: {
    instanceNumId: bigint | number
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
    aqFile: AlgoQuartersFile
    /** Top up instance/registry app MBR shortfalls from the writer instead of throwing */
    autoFund?: boolean
    note?: string
  }): Promise<{ committeeNumId: number; committeeAq: FracCommitteeAq }> {
    // TODO add uningest support

    const rows = parseAqFile(aqFile)
    const totalAq = BigInt(aqFile.totalAlgoQuarters)
    const totalAccounts = aqFile.totalAccounts

    // A manifest is bound to a network; uploading e.g. a mainnet file to testnet must not get far.
    const sp = await this.algorand.getSuggestedParams()
    const networkGenesisHash = Buffer.from(sp.genesisHash!).toString('base64')
    if (networkGenesisHash !== aqFile.networkGenesisHash) {
      throw new Error(
        `uploadAqFile: manifest genesis hash ${aqFile.networkGenesisHash} does not match network ${networkGenesisHash}`,
      )
    }

    let committee = await this.getCommittee(instanceNumId, committeeId)
    if (!committee) {
      if (this.debug) console.log('uploadAqFile: committee not synced on instance, syncing...')
      await this.syncCommittee({ instanceNumId, committeeId, note })
      committee = await this.getCommittee(instanceNumId, committeeId)
      if (!committee) throw new Error('uploadAqFile: syncCommittee produced no committee snapshot')
    }
    const committeeNumId = Number(committee.committeeNumId)

    // Address → registry record: account ID (0 = never seen) and the instances it is linked to. Used
    // for the resume set and for the registry MBR estimate.
    const addresses = rows.map(({ account }) => account)
    const recordMap = await this.registry.getFracRegAccountsMap(addresses)
    const idMap = new Map(addresses.map((account) => [account, recordMap.get(account)?.accountId ?? 0]))

    const ledger = await this.getCommitteeAq(instanceNumId, committeeNumId)
    const pristine = !ledger || (Number(ledger.ingestedAq) === 0 && Number(ledger.numAccounts) === 0)
    const totalsMatch = !!ledger && BigInt(ledger.totalAq) === totalAq && Number(ledger.totalAccounts) === totalAccounts
    if (!ledger || (pristine && !totalsMatch)) {
      if (this.debug) console.log(`uploadAqFile: opening ledger, totalAq ${totalAq}, totalAccounts ${totalAccounts}`)
      await this.startAqIngest({ instanceNumId, committeeId, totalAq: Number(totalAq), totalAccounts, note })
    } else if (!totalsMatch) {
      throw new Error(
        `uploadAqFile: ledger totals are frozen at ${ledger.totalAq} AQ / ${ledger.totalAccounts} accounts ` +
          `but the manifest declares ${totalAq} / ${totalAccounts} — wrong manifest for this committee?`,
      )
    }

    // Resume set: which manifest rows are already on chain. Only worth probing when something has
    // been ingested, and only registered accounts (id > 0) can have a box.
    const ingestedAqByAddress = new Map<string, number>()
    if (ledger && Number(ledger.numAccounts) > 0) {
      const registered = addresses.filter((account) => (idMap.get(account) ?? 0) > 0)
      const aqs = registered.length
        ? await this.getAccountAqs(
            instanceNumId,
            committeeNumId,
            registered.map((account) => idMap.get(account)!),
          )
        : []
      registered.forEach((account, index) => {
        if (aqs[index] > 0) ingestedAqByAddress.set(account, aqs[index])
      })
      for (const { account, aq } of rows) {
        const onChain = ingestedAqByAddress.get(account)
        if (onChain !== undefined && onChain !== aq) {
          throw new Error(`uploadAqFile: ${account} already ingested with ${onChain} AQ, manifest says ${aq}`)
        }
      }
      // Every ingested account must be a manifest row, else this ledger belongs to another file.
      if (ingestedAqByAddress.size !== Number(ledger.numAccounts)) {
        throw new Error(
          `uploadAqFile: ledger holds ${ledger.numAccounts} ingested accounts but only ` +
            `${ingestedAqByAddress.size} of them appear in the manifest — wrong manifest for this committee?`,
        )
      }
    }
    const remainder = rows.filter(({ account }) => !ingestedAqByAddress.has(account))

    // MBR pre-check before any ingest lands: an underfunded app otherwise fails resource population
    // with an opaque error, part-way through the batches.
    if (remainder.length > 0) {
      // Registry side: a never-seen account gets a box, a known account joining this instance for the
      // first time gets one more instance id in its box, an account already linked costs nothing.
      let newRegistryAccounts = 0
      let joiningRegistryAccounts = 0
      for (const { account } of remainder) {
        const record = recordMap.get(account)
        if (!record || Number(record.accountId) === 0) newRegistryAccounts++
        else if (!record.instanceNumIds.some((id) => Number(id) === instanceNumId)) joiningRegistryAccounts++
      }
      const instanceCost = BigInt(remainder.length) * AQ_INSTANCE_MBR_PER_ACCOUNT_MICROALGOS
      const registryCost =
        BigInt(newRegistryAccounts) * AQ_REGISTRY_MBR_PER_NEW_ACCOUNT_MICROALGOS +
        BigInt(joiningRegistryAccounts) * AQ_REGISTRY_MBR_PER_JOINING_ACCOUNT_MICROALGOS
      const instanceAddress = getApplicationAddress(await this.getInstanceAppId(instanceNumId)).toString()
      const registryAddress = this.registryReadClient.appAddress.toString()
      const algod = this.algorand.client.algod
      const [instanceSpendable, registrySpendable] = await Promise.all([
        getSpendableBalance(algod, instanceAddress),
        getSpendableBalance(algod, registryAddress),
      ])
      const shortfalls = [
        { label: 'instance', address: instanceAddress, cost: instanceCost, available: instanceSpendable },
        { label: 'registry', address: registryAddress, cost: registryCost, available: registrySpendable },
      ]
        .map((entry) => ({ ...entry, shortfall: entry.cost > entry.available ? entry.cost - entry.available : 0n }))
        .filter(({ shortfall }) => shortfall > 0n)
      if (shortfalls.length > 0 && !autoFund) {
        throw new Error(
          'uploadAqFile: insufficient app funds for box MBR: ' +
            shortfalls
              .map(({ label, address, shortfall }) => `${label} app ${address} needs ${shortfall} µAlgo`)
              .join('; ') +
            ' — top up, or pass autoFund: true',
        )
      }
      for (const { label, address, shortfall } of shortfalls) {
        if (this.debug) console.log(`uploadAqFile: funding ${label} app ${address} with ${shortfall} µAlgo`)
        await this.algorand.send.payment({
          sender: this.writerAccount!.sender,
          signer: this.writerAccount!.signer,
          receiver: address,
          amount: Number(shortfall).microAlgo(),
          note,
        })
      }

      const batches = chunk(remainder, MAX_ACCOUNTS_PER_INGEST_AQ)
      if (this.debug)
        console.log(`uploadAqFile: ingesting ${remainder.length} accounts in ${batches.length} batches...`)
      // Sequential on purpose - do NOT pMap these. For an account the frac registry has never
      // seen, resource population predicts the accountId its accountAq box name derives from;
      // concurrent batches would predict the same next ids and all but the first to commit would
      // fail with "invalid Box reference".
      for (const batch of batches) {
        const { txIds } = await this.ingestAq({
          instanceNumId,
          committeeNumId,
          accountAqs: batch.map(({ account, aq }): [string, number] => [account, aq]),
          note,
        })
        if (this.debug) console.log(`uploadAqFile: batch of ${batch.length} ingested`, txIds[txIds.length - 1])
      }
    }

    const committeeAq = (await this.getCommitteeAq(instanceNumId, committeeNumId))!
    if (BigInt(committeeAq.ingestedAq) !== totalAq || Number(committeeAq.numAccounts) !== totalAccounts) {
      throw new Error(
        `uploadAqFile: ledger incomplete after upload: ${committeeAq.ingestedAq}/${totalAq} AQ, ` +
          `${committeeAq.numAccounts}/${totalAccounts} accounts`,
      )
    }
    return { committeeNumId, committeeAq }
  }

  /**
   * Remove one batch of accounts' AlgoQuarters from committee `committeeNumId`. Operator only.
   *
   * The correction and MBR-reclaim path: deleting each account's box lowers the instance app
   * account's minimum balance, so drain a settled committee and sweep the freed ALGO with
   * `withdrawALGO`. Draining a ledger to `ingestedAq === 0` re-opens `startAqIngest` for a new total.
   *
   * Takes addresses (like `ingestAq`); the contract resolves each to its account ID via a readonly
   * registry read, so an account never ingested for this committee is rejected rather than removed.
   * Order-independent; no duplicates. One group per call — use {@link uningestAqAll} for a whole set.
   */
  @requireWriter()
  @wrapErrors()
  makeUningestAqTxns({
    instanceNumId: _instanceNumId,
    committeeNumId,
    accounts,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['uningestAq(uint16,address[])void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    if (accounts.length === 0) throw new Error('uningestAq: no accounts to uningest')
    if (accounts.length > MAX_ACCOUNTS_PER_UNINGEST_AQ) {
      throw new Error(
        `uningestAq: ${accounts.length} accounts exceeds the ${MAX_ACCOUNTS_PER_UNINGEST_AQ} per call — ` +
          `chunk them, or use uningestAqAll.`,
      )
    }
    // Reference slots (2N+2: per account the registry's accounts box read by getAccount and this
    // instance's accountAq box, plus the registryApp ref and the committeeAq box) are measured and
    // padded for by the executor.
    // extraFee covers one getAccount inner call per account.
    return builder.uningestAq({
      args: { committeeNumId, accounts },
      note,
      extraFee: (accounts.length * 1000).microAlgo(),
    })
  }

  uningestAq = this.makeInstanceTxnExecutor({ maker: this.makeUningestAqTxns })

  /**
   * Remove every entry of `accounts` from committee `committeeNumId`, one group per
   * {@link MAX_ACCOUNTS_PER_UNINGEST_AQ} accounts. Sequential and atomic per group, so a failure
   * part-way leaves earlier batches removed — re-run with the remainder, which is safe because an
   * account already removed is rejected rather than double-counted.
   */
  @requireWriter()
  @wrapErrors()
  async uningestAqAll({
    instanceNumId,
    committeeNumId,
    accounts,
    note,
  }: FracDelegationInstanceContractArgs['uningestAq(uint16,address[])void'] & {
    instanceNumId: bigint | number
    note?: string
  }) {
    for (const batch of chunk(accounts, MAX_ACCOUNTS_PER_UNINGEST_AQ)) {
      await this.uningestAq({ instanceNumId, committeeNumId, accounts: batch, note })
    }
  }

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
   * The executor pads the group with no-op app calls when the escrow count needs more reference
   * slots than one transaction carries — see `sdk-shared`.
   */
  @requireWriter()
  @wrapErrors()
  async makeSyncPeriodTxns({
    instanceNumId: _instanceNumId,
    periodApp,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['syncPeriod(uint64)(uint64,byte[32],uint16,uint32,uint32,uint32[],uint8)'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    // Reference slots (N+6: one box per escrow, plus periods/periodVoteCache/committees, the
    // period app's topicOptionsArr box and the periodApp + registryApp refs) are measured and
    // padded for by the executor.
    // extraFee covers the single inner call to the period app: getPeriodShort.
    return builder.syncPeriod({ args: { periodApp }, note, extraFee: (1000).microAlgo() })
  }

  syncPeriod = this.makeInstanceTxnExecutor({ maker: this.makeSyncPeriodTxns })

  // ── Voting ───────────────────────────────────────────────────────

  /**
   * Internal vote on gGov period `periodId`, callable by any account with ingested AlgoQuarters in
   * the period's committee, or by that account's delegatee. `topicVotes` is [topic][option]
   * AlgoQuarters, parallel to the period's topics; every topic's row must sum to the voter's full AQ
   * weight (abstain explicitly via each topic's last option). Re-votes overwrite.
   *
   * `voterAccount` defaults to this SDK's `writerAccount` — a plain self-vote. To cast a delegated
   * vote, give the SDK a `writerAccount` whose signer is the delegatee and pass the delegator as
   * `voterAccount`; the delegation itself lives on the gGov registry (`set_voting_account`), which
   * is the single source of truth for gGov and frac delegations alike. A delegatee can never
   * overwrite a vote the owner cast directly (`ERR:GV_OD`).
   *
   * Whenever the vote moves the instance's mapped gGov target, the contract re-casts the delta
   * externally through its escrows inside this same group — the first vote on a period always
   * re-casts every escrow on every topic. Fees and reference padding are therefore provisioned for
   * the worst case up front (a no-op re-vote still pays them: extraFee is spent, not refunded).
   *
   * Vote record MBR is paid by the instance app account on an account's first vote. It pulls a
   * top-up from the registry when needed, so what needs funding is the REGISTRY app account, not
   * each instance: keep it above `numVoters * voteRecordMBR + mbrTopUp`, and recover leftovers
   * from instances via `withdrawInstanceALGO`.
   */
  @requireWriter()
  @wrapErrors()
  async makeVoteTxns({
    instanceNumId,
    periodId,
    voterAccount,
    topicVotes,
    note,
    client,
    builder,
    readCache,
  }: Omit<FracDelegationInstanceContractArgs['vote(address,uint32,uint32[])void'], 'voterAccount' | 'topicVotes'> & {
    /** Defaults to this SDK's writerAccount (self-vote) */
    voterAccount?: string
    /** `[topic][option]`; flattened for the contract, which takes the concatenated shape. */
    topicVotes: number[][]
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    const numEscrows = await this.escrowCountUpperBound(instanceNumId, readCache)
    const gGovRegistryAppId = await this.getGGovRegistryAppId()
    // The sender is always this SDK's writerAccount; the voter defaults to it (self-vote).
    const effectiveSender = String(this.writerAccount!.sender)
    const voter = voterAccount === undefined ? effectiveSender : String(voterAccount)
    const isDelegated = voter !== effectiveSender
    // Worst-case inner calls: 1 registry getAccount, 1 gGov registry getDelegate when delegated,
    // plus per re-cast escrow the period vote() and the two registry reads it makes itself
    // (getDelegate + getGovVotingPower).
    const innerCalls = 1 + (isDelegated ? 1 : 0) + numEscrows * 3
    // Reference slots are measured off simulate and padded for by the executor: roughly 5 per
    // re-cast escrow (its account ref, this instance's periodEscrowVotes box, the period app's
    // per-escrow vote record, the gGov registry's delegations + accounts boxes) plus ~22 fixed
    // (3 app refs and the boxes of all four apps this vote touches), and 2 more for a delegated
    // vote. Each pad also adds 16 inner-txn allowance and 700 opcodes, both of which the ref
    // demand dominates. What simulate cannot see — the state-dependent MBR branches — is declared
    // statically below.
    const opts: Parameters<typeof builder.vote>[0] = {
      args: { voterAccount: voter, periodId, topicVotes: flattenTopicVotes(topicVotes) },
      note,
      // The two MBR inner calls are deliberately NOT counted here: both pay their own fee, so
      // the group's fee must not depend on whether the top-up fires.
      extraFee: (innerCalls * 1000).microAlgo(),
      // Resources whose need is state-dependent must be declared statically for the worst case.
      // checkNeedMBR reads these boxes only when the app is at or below its minimum balance - a
      // branch another voter's transaction can flip between simulate and execution. Since resource
      // population resolves references by simulating, a group that simulated without the top-up
      // would hit an unavailable box error.
      // Two of them, because this vote nests another: the frac registry's `instances` box for this
      // instance's own top-up, and the gGov registry's `periods` box for the GGovPeriod.vote each
      // re-cast escrow triggers - that inner vote allocates a per-escrow record and runs its own
      // checkNeedMBR.
      // The app refs are not redundant with population: algosdk encodes box refs against this txn's
      // own foreign-apps at build time, before population runs.
      appReferences: [this.registryReadClient.appId, ...(gGovRegistryAppId ? [gGovRegistryAppId] : [])],
      boxReferences: [
        { appId: this.registryReadClient.appId, name: instanceBoxName(Number(instanceNumId)) },
        // Omitted when unset (0n): an instance with no gGov registry cannot vote at all, and the
        // on-chain failure names the cause better than an app reference of 0 would.
        ...(gGovRegistryAppId ? [{ appId: gGovRegistryAppId, name: periodBoxName(periodId) }] : []),
      ],
    }
    if (isDelegated) {
      // The contract requires the delegator at Txn.accounts(1) so delegated votes are visible to
      // indexers/explorers. Setting it explicitly keeps it first; resource population appends.
      opts.accountReferences = [voter]
    }
    return builder.vote(opts)
  }

  vote = this.makeInstanceTxnExecutor({ maker: this.makeVoteTxns })

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

  private updateInstanceAppCode = this.makeInstanceTxnExecutor({ maker: this.makeUpdateInstanceAppTxns })

  /**
   * Update a deployed instance app's program, optionally resizing its global schema and extra
   * program pages in the same transaction.
   *
   * The instance apps the registry spawns are sized to exactly what `FracDelegationInstanceContract`
   * declares, so a build that adds global state needs the deployed apps grown to match — that is
   * what `size` is for. Growing is only expressible on an ApplicationUpdate (AVM v13), and
   * algokit-utils cannot carry those fields, so a resize leaves the composer and is sent by
   * {@link sendAppSizeUpdate}. Without `size` this is the ordinary code update as before.
   *
   * Admin-only either way. Note the resize path makes the *admin* the app's `sizeSponsor`, taking on
   * the instance app's whole schema + extra-page MBR (the registry app account, as creator, keeps
   * only the flat per-app base). Budget for that before growing apps in bulk.
   */
  updateInstanceApp = async ({
    instanceNumId,
    size,
    note,
  }: {
    instanceNumId: bigint | number
    size?: AppSizeParams
    note?: string
  }): Promise<SendResult | { txId: string }> => {
    if (!hasAppSizeChange(size)) return this.updateInstanceAppCode({ instanceNumId, note })
    if (!this.writerAccount) throw new Error('writerAccount not set on the SDK instance')
    const client = await this.getInstanceWriteClient(instanceNumId)
    const byteCode = client.appClient.appSpec.byteCode
    return wrapErrorsInternal(
      sendAppSizeUpdate({
        algorand: this.algorand,
        appId: client.appId,
        account: this.writerAccount,
        size,
        approvalProgram: byteCode ? Buffer.from(byteCode.approval, 'base64') : undefined,
        clearStateProgram: byteCode ? Buffer.from(byteCode.clear, 'base64') : undefined,
        // The instance contract resolves the admin from the registry's `admin` global, so the
        // registry must be referenced; outside the composer nothing populates that for us.
        appReferences: [this.registry.appId],
        note,
      }),
    )
  }

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
