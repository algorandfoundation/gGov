import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { Address } from 'algosdk'
import { GGovRegistrySDK, SendResult, executeTxns } from '../registry'
import { GGovPeriodClient, GGovPeriodComposer } from '../generated/GGovPeriodClient'
import { GGovReaderSDK } from './sdkReader'
import {
  BodyJson,
  PeriodBodyJson,
  CommitteeId,
  ConstructorArgs,
  GGovPeriodContractArgs,
  PeriodMethodBuilderArgs,
  SenderWithSigner,
  validateBodyJson,
} from './types'
import { committeeIdToRaw } from '../util/comitteeId'
import { asciiBoxName, topicBodyBoxName } from '../util/boxNames'
import { chunk } from '../util/chunk'
import { requireWriter } from '../util/requiresSender'
import { wrapErrors, wrapErrorsInternal } from '../util/wrapErrors'
import { MAX_GROUP_SIZE, BODY_CHUNK_BYTES } from '../constants'

/** Max box references per transaction (AVM limit) — caps how many topic bodies one deleteTopicBodies call may delete. */
const MAX_BOX_REFS_PER_TXN = 8

export class GGovSDK extends GGovReaderSDK {
  public writerAccount?: SenderWithSigner
  /** Composed registry SDK (writer-enabled). Reach registry writes/reads via `sdk.registry.X`. */
  declare public registry: GGovRegistrySDK
  /** periodId → cached writer client. */
  protected periodWriteClientCache: Map<bigint, GGovPeriodClient> = new Map()

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest)
    this.writerAccount = writerAccount
    this.registry = new GGovRegistrySDK({
      writerAccount,
      ...rest,
    })
  }

  // ── Period client cache ──────────────────────────────────────────

  protected async getPeriodWriteClient(periodId: bigint | number): Promise<GGovPeriodClient> {
    if (!this.writerAccount) throw new Error('writerAccount required')
    const pid = BigInt(periodId)
    const cached = this.periodWriteClientCache.get(pid)
    if (cached) return cached
    const appId = await this.getPeriodAppId(pid)
    const client = new GGovPeriodClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.writerAccount.sender,
      defaultSigner: this.writerAccount.signer,
    })
    this.periodWriteClientCache.set(pid, client)
    return client
  }

  // ── Executor factories ───────────────────────────────────────────

  /**
   * Period-side executor factory. Resolves the per-period client at call time, binds the
   * empty-group factory to that client, then runs the standard executeTxns flow (which also
   * auto-increases opcode budget via getIncreaseBudgetBuilder).
   */
  private makePeriodTxnExecutor = <T extends (...args: any) => any, R = SendResult>({
    maker,
    returnTransformer,
    sendParams,
  }: {
    maker: T
    returnTransformer?: (result: SendResult) => R
    sendParams?: SendParams
  }) => {
    return async (args: Omit<Parameters<T>[0], 'builder' | 'client'>): Promise<R> => {
      if (!this.writerAccount) throw new Error('writerAccount not set on the SDK instance')
      const client = await this.getPeriodWriteClient((args as any).periodId)
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

  // ── Registry passthrough (end-user delegation write) ─────────────
  // setVotingAccount is the one registry write an end user performs — delegating or clearing
  // their OWN voting power — so it's forwarded for ergonomics. Admin/operator/bootstrap writes
  // (setOperator, setAdmin, addPeriod, committee ingest, withdrawALGO, uploadPeriodApprovalProgram,
  // createRegistry, …) stay on `this.registry`. The end-user delegation READS (getDelegation,
  // getDelegators) are forwarded on GGovReaderSDK and inherited here.

  /** Delegate (or clear) the signer's own voting power. See GGovRegistrySDK.setVotingAccount. */
  setVotingAccount = (args: Parameters<GGovRegistrySDK['setVotingAccount']>[0]) => this.registry.setVotingAccount(args)

  // ── Period: editPeriod ───────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeEditPeriodTxns({
    periodId: _periodId,
    committeeId,
    votingStart,
    votingEnd,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    committeeId: CommitteeId
    votingStart: bigint | number
    votingEnd: bigint | number
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.editPeriod({
      args: { committeeId: committeeIdToRaw(committeeId), votingStart, votingEnd },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    })
  }

  editPeriod = this.makePeriodTxnExecutor({ maker: this.makeEditPeriodTxns })

  // ── Period: addTopic (returns topic index) ───────────────────────

  @requireWriter()
  @wrapErrors()
  makeAddTopicTxns({
    periodId: _periodId,
    options,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    options: string[]
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.addTopic({
      args: { options },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    })
  }

  addTopic = this.makePeriodTxnExecutor<typeof this.makeAddTopicTxns, bigint>({
    maker: this.makeAddTopicTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? []
      return BigInt(returns[returns.length - 1] ?? returns[0] ?? 0)
    },
  })

  // ── Period: editTopic ────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeEditTopicTxns({
    periodId: _periodId,
    topicIndex,
    options,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    topicIndex: bigint | number
    options: string[]
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.editTopic({
      args: { topicIndex, options },
      note,
      // 1 inner verifyOperator (no summary change)
      extraFee: (1000).microAlgo(),
    })
  }

  editTopic = this.makePeriodTxnExecutor({ maker: this.makeEditTopicTxns })

  // ── Period: uploadPeriodBodyPartial ──────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeUploadPeriodBodyPartialTxns({
    periodId: _periodId,
    startOffset,
    data,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    startOffset: bigint | number
    data: Uint8Array
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.uploadPeriodBodyPartial({
      args: { startOffset, data },
      note,
      extraFee: (1000).microAlgo(),
    })
  }

  uploadPeriodBodyPartial = this.makePeriodTxnExecutor({ maker: this.makeUploadPeriodBodyPartialTxns })

  // ── Period: uploadTopicBodyPartial ───────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeUploadTopicBodyPartialTxns({
    periodId: _periodId,
    topicIndex,
    startOffset,
    data,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    topicIndex: bigint | number
    startOffset: bigint | number
    data: Uint8Array
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.uploadTopicBodyPartial({
      args: { topicIndex, startOffset, data },
      note,
      extraFee: (1000).microAlgo(),
    })
  }

  uploadTopicBodyPartial = this.makePeriodTxnExecutor({ maker: this.makeUploadTopicBodyPartialTxns })

  /** Upload a full period body, chunked into groups of up to 16 txns. */
  @requireWriter()
  @wrapErrors()
  async uploadPeriodBody({
    periodId,
    body,
    note,
  }: {
    periodId: bigint | number
    body: PeriodBodyJson | string | Uint8Array
    note?: string | Uint8Array
  }): Promise<void> {
    const client = await this.getPeriodWriteClient(periodId)
    const data = serializeAndValidateBody(body)
    const chunks = chunk(Array.from(data), BODY_CHUNK_BYTES)
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    )
    for (const group of groups) {
      let builder: GGovPeriodComposer<any> = client.newGroup()
      for (const { index, data: chunkData } of group) {
        // The maker is @wrapErrors-decorated so it returns a Promise; await to unwrap.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        builder = await this.makeUploadPeriodBodyPartialTxns({
          periodId,
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          note,
          client,
          builder,
        })
      }
      await builder.send()
    }
  }

  /** Upload a full topic body, chunked into groups of up to 16 txns. */
  @requireWriter()
  @wrapErrors()
  async uploadTopicBody({
    periodId,
    topicIndex,
    body,
    note,
  }: {
    periodId: bigint | number
    topicIndex: bigint | number
    body: BodyJson | string | Uint8Array
    note?: string | Uint8Array
  }): Promise<void> {
    const client = await this.getPeriodWriteClient(periodId)
    const data = serializeAndValidateBody(body)
    const chunks = chunk(Array.from(data), BODY_CHUNK_BYTES)
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    )
    for (const group of groups) {
      let builder: GGovPeriodComposer<any> = client.newGroup()
      for (const { index, data: chunkData } of group) {
        // The maker is @wrapErrors-decorated so it returns a Promise; await to unwrap.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        builder = await this.makeUploadTopicBodyPartialTxns({
          periodId,
          topicIndex,
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          note,
          client,
          builder,
        })
      }
      await builder.send()
    }
  }

  // ── Period: removeTopic ──────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeRemoveTopicTxns({
    periodId: _periodId,
    topicIndex,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    topicIndex: bigint | number
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.removeTopic({
      args: { topicIndex },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    })
  }

  removeTopic = this.makePeriodTxnExecutor({ maker: this.makeRemoveTopicTxns })

  // ── Period: setReady ─────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeSetReadyTxns({
    periodId: _periodId,
    ready,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    ready: boolean
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.setReady({
      args: { ready },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary
      extraFee: (2000).microAlgo(),
    })
  }

  setReady = this.makePeriodTxnExecutor({ maker: this.makeSetReadyTxns })

  // ── Period: vote ─────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeVoteTxns({
    periodId: _periodId,
    voterAccount,
    topicVotes,
    note,
    client,
    builder,
  }: GGovPeriodContractArgs['vote(address,uint32[][])void'] & {
    periodId: bigint | number
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()

    const opts: any = {
      args: { voterAccount, topicVotes },
      note,
      // 1 inner getDelegate (when delegated) + 1 inner getXGovVotingPower
      extraFee: (1000).microAlgo(),
    }
    // The sender is always this SDK's writerAccount. Self-vote: writerAccount === voterAccount.
    // Delegated vote: writerAccount is the delegatee and voterAccount is the delegator (someone who
    // delegated to them). In the delegated case the contract requires the delegator to be referenced
    // in the foreign-accounts array so the vote is visible to indexers/explorers; for self-votes it
    // doesn't check, so we omit it. To cast a delegated vote, give the SDK a writerAccount whose
    // signer is the delegatee and pass the delegator as voterAccount.
    const effectiveSender = String(this.writerAccount!.sender)
    if (effectiveSender !== String(voterAccount)) {
      opts.accountReferences = [voterAccount]
      opts.extraFee = (2000).microAlgo() // +1 inner account ref for delegation check
    }
    return builder.vote(opts)
  }

  vote = this.makePeriodTxnExecutor({ maker: this.makeVoteTxns })

  // ── Period: updateApplication (admin-only app-code update) ────────

  /**
   * Update a deployed period app's program to the GGovPeriod build exported by this
   * `ggov-sdk` version. The period write client compiles the current approval/clear
   * programs from its embedded app spec, so the on-chain code is replaced with the
   * version bundled here. Admin-only (the contract's updateApplication baremethod
   * inner-calls registry.verifyAdmin).
   */
  @requireWriter()
  @wrapErrors()
  makeUpdatePeriodAppTxns({
    periodId: _periodId,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.update.bare({
      note,
      // 1 inner verifyAdmin (checkAdminCaller)
      extraFee: (1000).microAlgo(),
    })
  }

  updatePeriodApp = this.makePeriodTxnExecutor({ maker: this.makeUpdatePeriodAppTxns })

  // ── Period: deleteApplication (admin-only, !ready) — full box cleanup + ALGO reclaim ──

  /**
   * Delete a deployed period app and reclaim ALL of its box min-balance. Admin-only and only while
   * the period is not ready (the contract's deleteApplication baremethod inner-calls
   * registry.verifyAdmin, then enforces !ready).
   *
   * Deleting an app does NOT delete its boxes — the box MBR would be locked forever — so this first
   * clears every per-topic body box ('T'+index) in batches of {@link MAX_BOX_REFS_PER_TXN} (the AVM
   * box-reference limit), then the final delete deletes the always-present option/vote boxes
   * ('o','t') and the optional period body ('P'), inner-calls registry.removePeriodSummary to drop
   * the summary box, and sweeps the whole app-account balance (base + freed box MBR) back to the
   * deleting admin via closeRemainderTo. No prior withdrawal is needed.
   */
  @requireWriter()
  @wrapErrors()
  async deletePeriodApp({ periodId, note }: { periodId: bigint | number; note?: string | Uint8Array }): Promise<void> {
    const client = await this.getPeriodWriteClient(periodId)
    const appId = await this.getPeriodAppId(periodId)

    // Enumerate existing boxes. 'o'/'t' (options/votes) are always present; 'P' is the optional
    // period body; each topic that uploaded a body has a 'T'+uint32 box. 'v' (vote records) cannot
    // exist while !ready. Anything else is unexpected — refuse rather than silently strand its MBR.
    const topicBodyIndexes: number[] = []
    for (const { nameRaw } of await this.algorand.app.getBoxNames(appId)) {
      const tag = nameRaw[0]
      if (tag === 0x54 /* 'T' */ && nameRaw.length === 5) {
        topicBodyIndexes.push(new DataView(nameRaw.buffer, nameRaw.byteOffset, nameRaw.byteLength).getUint32(1))
      } else if (tag === 0x6f /* 'o' */ || tag === 0x74 /* 't' */ || (tag === 0x50 /* 'P' */ && nameRaw.length === 1)) {
        // handled by the final delete txn
      } else {
        throw new Error(
          `Period ${periodId} (app ${appId}) has an unexpected box 0x${[...nameRaw].map((b) => b.toString(16).padStart(2, '0')).join('')}; refusing to delete`,
        )
      }
    }

    // Paged cleanup of topic-body boxes: <=8 box references per txn, <=MAX_GROUP_SIZE txns per group.
    const groups = chunk(chunk(topicBodyIndexes, MAX_BOX_REFS_PER_TXN), MAX_GROUP_SIZE)
    for (const group of groups) {
      let builder: GGovPeriodComposer<any> = client.newGroup()
      for (const indexes of group) {
        builder = builder.deleteTopicBodies({
          args: { topicIndexes: indexes.map((i) => BigInt(i)) },
          boxReferences: indexes.map(topicBodyBoxName),
          note,
          // 1 inner verifyAdmin (checkAdminCaller)
          extraFee: (1000).microAlgo(),
        })
      }
      await builder.send()
    }

    // Final delete: deletes 'o'/'t'/'P' (all referenced — box_del requires the ref even when the box
    // is absent), drops the registry summary, and sweeps the balance via closeRemainderTo.
    await client
      .newGroup()
      .delete.bare({
        note,
        boxReferences: [asciiBoxName('o'), asciiBoxName('t'), asciiBoxName('P')],
        // 1 inner verifyAdmin (checkAdminCaller) + 1 inner removePeriodSummary + 1 inner sweep payment
        extraFee: (3000).microAlgo(),
      })
      .send()
  }

  // ── Period: withdrawALGO (admin-only, via registry C2C verifyAdmin) ──

  /**
   * Withdraw `amount` µAlgo from the period app account to `receiver`. Registry admin only
   * (the contract's withdrawALGO inner-calls registry.verifyAdmin). Exposed as
   * `withdrawPeriodALGO` to avoid colliding with the registry's `withdrawALGO` on this SDK;
   * the on-chain method is `withdrawALGO`.
   */
  @requireWriter()
  @wrapErrors()
  makeWithdrawPeriodALGOTxns({
    periodId: _periodId,
    receiver,
    amount,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number
    receiver: string | Address
    amount: bigint | number
    client: GGovPeriodClient
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup()
    return builder.withdrawAlgo({
      args: { receiver: receiver.toString(), amount },
      note,
      // 1 inner verifyAdmin + 1 inner payment
      extraFee: (2000).microAlgo(),
    })
  }

  withdrawPeriodALGO = this.makePeriodTxnExecutor({ maker: this.makeWithdrawPeriodALGOTxns })
}

function serializeAndValidateBody(body: BodyJson | string | Uint8Array): Uint8Array {
  if (typeof body === 'object' && !(body instanceof Uint8Array)) {
    if (!validateBodyJson(body)) {
      throw new Error(
        "Body must have 'title' (string) and 'body' (string) fields, and 'electSeats' (if present) must be a positive integer",
      )
    }
    return new TextEncoder().encode(JSON.stringify(body))
  }
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Body must be valid JSON with 'title' (string) and 'body' (string) fields")
  }
  if (!validateBodyJson(parsed)) {
    throw new Error("Body must have 'title' (string) and 'body' (string) fields")
  }
  return typeof body === 'string' ? new TextEncoder().encode(body) : body
}
