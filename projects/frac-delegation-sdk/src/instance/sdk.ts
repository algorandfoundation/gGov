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
import { chunk } from '../util/chunk'
import { noteNonce } from '../util/noteNonce'
import {
  MAX_ACCOUNTS_PER_INGEST_AQ,
  MAX_ACCOUNTS_PER_UNINGEST_AQ,
  MAX_GROUP_SIZE,
  REF_SLOTS_PER_APP_CALL,
} from '../constants'

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
   * and the registry `AQ_REGISTRY_MBR_PER_NEW_ACCOUNT_MICROALGOS` per account it has never seen (see
   * `constants.ts`). There is no funding path from the instance to the registry.
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
    // Slots: 2 per account (this instance's accountAq box, and the registry's accounts box that
    // getOrCreateAccountWithInstance reads/writes), plus a fixed 3 — the registryApp ref (also what
    // resolveOperator reads), the registry's instances box, and this instance's committeeAq box.
    builder = this.padForRefSlots(builder, accountAqs.length * 2 + 3, 'ingestAq')
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
    // Slots: 2 per account (the registry's accounts box read by getAccount + this instance's
    // accountAq box), plus the registryApp ref and this instance's committeeAq box. No registry
    // instances box — getAccount, unlike getOrCreateAccountWithInstance, doesn't touch it.
    builder = this.padForRefSlots(builder, accounts.length * 2 + 2, 'uningestAq')
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

  // ── Voting ───────────────────────────────────────────────────────

  /**
   * Internal vote on gGov period `periodId`, callable by any account with ingested AlgoQuarters in
   * the period's committee. `topicVotes` is [topic][option] AlgoQuarters, parallel to the period's
   * topics; every topic's row must sum to the sender's full AQ weight (abstain explicitly via each
   * topic's last option). Re-votes overwrite.
   *
   * Whenever the vote moves the instance's mapped gGov target, the contract re-casts the delta
   * externally through its escrows inside this same group — the first vote on a period always
   * re-casts every escrow on every topic. Fees and reference padding are therefore provisioned for
   * the worst case up front (a no-op re-vote still pays them: extraFee is spent, not refunded).
   *
   * The instance app account pays the `votingRecords` box MBR on an account's first vote — keep it
   * funded, sized by `committeeAq.numAccounts`.
   */
  @requireWriter()
  @wrapErrors()
  async makeVoteTxns({
    instanceNumId,
    periodId,
    topicVotes,
    note,
    client,
    builder,
  }: FracDelegationInstanceContractArgs['vote(uint32,uint32[][])void'] & {
    instanceNumId: bigint | number
    client: FracDelegationInstanceClient
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    const numEscrows = await this.escrowCountUpperBound(instanceNumId)
    // Worst-case inner calls: 1 registry getAccount, plus per re-cast escrow the period vote() and
    // the two registry reads it makes itself (getDelegate + getGovVotingPower).
    const innerCalls = 1 + numEscrows * 3
    // Slots, worst case (every escrow re-cast): 5 per escrow (the escrow's account ref — the inner
    // vote() passes it in its foreign-accounts array, so it must be available to the group — plus
    // this instance's periodEscrowVotes box, the period app's per-escrow vote record, and the gGov
    // registry's delegations + accounts boxes), plus a fixed ~20 (3 app refs: period app, frac
    // registry, gGov registry; this instance's periods/periodVoteCache/committees/committeeAq/
    // accountAq/votingRecords/escrows boxes; the frac registry's accounts box; the period's tallies
    // box; the gGov registry's committee metadata + member superbox). Each pad also adds 16
    // inner-txn allowance and 700 opcodes, both of which the ref demand dominates. Validated
    // against simulate in the e2e spec (8 escrows fail at 4-per-escrow sizing; 5 passes).
    builder = this.padForRefSlots(builder, numEscrows * 5 + 20, 'vote')
    return builder.vote({
      args: { periodId, topicVotes },
      note,
      extraFee: (innerCalls * 1000).microAlgo(),
    })
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
