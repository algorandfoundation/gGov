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
import { committeeIdToRaw } from '../util/comitteeId'
import { chunk } from '../util/chunk'
import {
  MAX_ACCOUNTS_PER_INGEST_AQ,
  MAX_ACCOUNTS_PER_UNINGEST_AQ,
  MAX_GROUP_SIZE,
  REF_SLOTS_PER_APP_CALL,
} from '../constants'

/** Keeps otherwise-identical padding app calls from colliding into one duplicate txn ID. */
const noteNonce = () => Math.floor(Math.random() * 100_000_000)

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

  // ── Reference-slot padding ───────────────────────────────────────

  /**
   * Escrow count to size reference padding from — an upper bound, never an under-estimate.
   *
   * `syncPeriod` actually sizes against the committee snapshot rather than `escrows`, but `escrows`
   * is append-only and the snapshot is rebuilt from it, so `escrowsVotes.length <= escrows.length`
   * always holds. Over-padding costs one min fee per spare txn; under-padding fails the group.
   */
  private async escrowCountUpperBound() {
    return (await this.getEscrows()).length
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
  @requireWriterWithClient()
  @wrapErrors()
  async makeSyncCommitteeTxns({
    committeeId,
    note,
    builder,
  }: Omit<FracDelegationInstanceContractArgs['syncCommittee(byte[32])(uint16,uint32[],uint32)'], 'committeeId'> & {
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    const numEscrows = await this.escrowCountUpperBound()
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

  syncCommittee = this.makeTxnExecutor({
    maker: this.makeSyncCommitteeTxns,
  })

  // ── AlgoQuarters ─────────────────────────────────────────────────

  /**
   * Open (or re-open) the AlgoQuarters ledger for gGov committee `committeeId`. Operator only.
   *
   * `totalAq` is the off-chain pipeline's declared total for the committee's period
   * (`AlgoQuartersData.totalAlgoQuarters`); `ingestAq` accumulates towards it and may never pass it.
   * The committee must already be synced (`syncCommittee`) — that snapshot is what supplies the
   * `committeeNumId` every later call keys by.
   *
   * Re-runnable only while nothing has been ingested; afterwards the total is frozen. Returns the
   * opened ledger, whose `committeeNumId` counterpart is on `getCommittee(committeeId)`.
   */
  @requireWriterWithClient()
  @wrapErrors()
  makeStartAqIngestTxns({
    committeeId,
    totalAq,
    note,
    builder,
  }: Omit<FracDelegationInstanceContractArgs['startAqIngest(byte[32],uint32)(uint32,uint32,uint32)'], 'committeeId'> & {
    /** 32-byte committee ID, raw bytes or base64 */
    committeeId: Uint8Array | string
  } & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    return builder.startAqIngest({ args: { committeeId: committeeIdToRaw(committeeId), totalAq }, note })
  }

  startAqIngest = this.makeTxnExecutor({
    maker: this.makeStartAqIngestTxns,
  })

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
  @requireWriterWithClient()
  @wrapErrors()
  makeIngestAqTxns({
    committeeNumId,
    accountAqs,
    note,
    builder,
  }: FracDelegationInstanceContractArgs['ingestAq(uint16,(address,uint32)[])void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
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

  ingestAq = this.makeTxnExecutor({
    maker: this.makeIngestAqTxns,
  })

  /**
   * Ingest every entry of `accountAqs` into committee `committeeNumId`, one group per
   * {@link MAX_ACCOUNTS_PER_INGEST_AQ} accounts. Sequential: each group is atomic on its own, so a
   * failure part-way leaves earlier batches ingested — re-run with the remainder, which is safe
   * because an already-ingested account is rejected rather than double-counted.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async ingestAqAll({
    committeeNumId,
    accountAqs,
    note,
  }: FracDelegationInstanceContractArgs['ingestAq(uint16,(address,uint32)[])void'] & { note?: string }) {
    for (const batch of chunk(accountAqs, MAX_ACCOUNTS_PER_INGEST_AQ)) {
      await this.ingestAq({ committeeNumId, accountAqs: batch, note })
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
  @requireWriterWithClient()
  @wrapErrors()
  makeUningestAqTxns({
    committeeNumId,
    accounts,
    note,
    builder,
  }: FracDelegationInstanceContractArgs['uningestAq(uint16,address[])void'] & InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
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

  uningestAq = this.makeTxnExecutor({
    maker: this.makeUningestAqTxns,
  })

  /**
   * Remove every entry of `accounts` from committee `committeeNumId`, one group per
   * {@link MAX_ACCOUNTS_PER_UNINGEST_AQ} accounts. Sequential and atomic per group, so a failure
   * part-way leaves earlier batches removed — re-run with the remainder, which is safe because an
   * account already removed is rejected rather than double-counted.
   */
  @requireWriterWithClient()
  @wrapErrors()
  async uningestAqAll({
    committeeNumId,
    accounts,
    note,
  }: FracDelegationInstanceContractArgs['uningestAq(uint16,address[])void'] & { note?: string }) {
    for (const batch of chunk(accounts, MAX_ACCOUNTS_PER_UNINGEST_AQ)) {
      await this.uningestAq({ committeeNumId, accounts: batch, note })
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
  @requireWriterWithClient()
  @wrapErrors()
  async makeSyncPeriodTxns({
    periodApp,
    note,
    builder,
  }: FracDelegationInstanceContractArgs['syncPeriod(uint64)(uint64,byte[32],uint16,uint32,uint32,uint32[],uint8)'] &
    InstanceMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    // Slots: N escrow boxes + periods + periodVoteCache + committees + the period app's
    // topicOptionsArr box (read by the getPeriodShort inner call) + 2 app refs (periodApp, and
    // registryApp which resolveOperator reads). Measured against simulate: N=6 -> 12, N=8 -> 14.
    builder = this.padForRefSlots(builder, (await this.escrowCountUpperBound()) + 6, 'syncPeriod')
    // extraFee covers the single inner call to the period app: getPeriodShort.
    return builder.syncPeriod({ args: { periodApp }, note, extraFee: (1000).microAlgo() })
  }

  syncPeriod = this.makeTxnExecutor({
    maker: this.makeSyncPeriodTxns,
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
