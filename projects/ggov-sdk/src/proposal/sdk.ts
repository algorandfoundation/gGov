import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { SendParams } from "@algorandfoundation/algokit-utils/types/transaction";
import { Address } from "algosdk";
import { GGovRegistrySDK, SendResult, createTxnExecutor, executeTxns } from "../registry";
import { GGovRegistryClient, GGovRegistryComposer, GGovRegistryFactory } from "../generated/GGovRegistryClient";
import { GGovPeriodClient, GGovPeriodComposer, GGovPeriodFactory } from "../generated/GGovPeriodClient";
import { GGovReaderSDK } from "./sdkReader";
import {
  BodyJson,
  CommitteeId,
  CommonMethodBuilderArgs,
  ConstructorArgs,
  GGovPeriodContractArgs,
  GGovRegistryContractArgs,
  PeriodMethodBuilderArgs,
  SenderWithSigner,
  validateBodyJson,
} from "./types";
import { committeeIdToRaw } from "../util/comitteeId";
import { chunk } from "../util/chunk";
import { requireWriter } from "../util/requiresSender";
import { wrapErrors, wrapErrorsInternal } from "../util/wrapErrors";

/** Algorand atomic group transaction limit. */
const MAX_GROUP_SIZE = 16;

/**
 * Default MBR (µAlgo) sent from operator to registry per createPeriod call.
 * Covers the spawned period app's account MBR: 100k base + 7*28.5k global ints +
 * 3*50k global bytes + 3*100k extra pages ≈ 750k. 1 ALGO buys a healthy buffer
 * and keeps the math stable if the period schema grows into its reserved slots.
 */
const DEFAULT_PERIOD_MBR_MICROALGOS = 1_000_000n;

/** Body chunk size for partial-upload txns. */
const BODY_CHUNK_BYTES = 2000;

export class GGovSDK extends GGovReaderSDK {
  public writerAccount?: SenderWithSigner;
  /** Registry write client. */
  public registryWriteClient?: GGovRegistryClient;
  /** Composed registry SDK (writer-enabled). Provides committee/operator/delegation writes. */
  declare public registry: GGovRegistrySDK;
  /** periodId → cached writer client. */
  protected periodWriteClientCache: Map<bigint, GGovPeriodClient> = new Map();

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest);
    this.writerAccount = writerAccount;
    if (writerAccount) {
      this.registry = new GGovRegistrySDK({
        algorand: this.algorand,
        concurrency: this.concurrency,
        debug: this.debug,
        registryAppId: this.registryAppId,
        readerAccount: undefined,
        writerAccount,
      });
      this.registryWriteClient = this.registry.writeClient!;
    }
  }

  // ── Period client cache ──────────────────────────────────────────

  protected async getPeriodWriteClient(periodId: bigint | number): Promise<GGovPeriodClient> {
    if (!this.writerAccount) throw new Error("writerAccount required");
    const pid = BigInt(periodId);
    const cached = this.periodWriteClientCache.get(pid);
    if (cached) return cached;
    const appId = await this.getPeriodAppId(pid);
    const client = new GGovPeriodClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.writerAccount.sender,
      defaultSigner: this.writerAccount.signer,
    });
    this.periodWriteClientCache.set(pid, client);
    return client;
  }

  // ── Executor factories ───────────────────────────────────────────

  /** Registry-side executor (single registry client). */
  private makeRegistryTxnExecutor = createTxnExecutor(
    this,
    () => this.registryWriteClient!.newGroup(),
    wrapErrorsInternal,
    () => this.writerAccount,
    () => this.algorand.client.algod,
  );

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
    maker: T;
    returnTransformer?: (result: SendResult) => R;
    sendParams?: SendParams;
  }) => {
    return async (args: Omit<Parameters<T>[0], "builder" | "client">): Promise<R> => {
      if (!this.writerAccount) throw new Error("writerAccount not set on the SDK instance");
      const client = await this.getPeriodWriteClient((args as any).periodId);
      const result = await wrapErrorsInternal(
        executeTxns({
          txnBuilder: (a: any) => (maker as any).call(this, { ...a, client }),
          txnBuilderArgs: { ...(args as object) } as any,
          emptyGroupBuilder: () => client.newGroup(),
          sendParams,
          writerAccount: this.writerAccount,
          algod: this.algorand.client.algod,
        }),
      );
      return returnTransformer ? returnTransformer(result) : (result as R);
    };
  };

  // ── Pass-throughs to composed registry SDK ───────────────────────
  // Inherited registry admin writes. Wrap to keep call signatures stable.

  uploadCommitteeFile = (...args: Parameters<GGovRegistrySDK["uploadCommitteeFile"]>) =>
    this.registry.uploadCommitteeFile(...args);
  registerCommittee = (args: Parameters<GGovRegistrySDK["registerCommittee"]>[0]) =>
    this.registry.registerCommittee(args);
  unregisterCommittee = (args: Parameters<GGovRegistrySDK["unregisterCommittee"]>[0]) =>
    this.registry.unregisterCommittee(args);
  ingestXGovs = (args: Parameters<GGovRegistrySDK["ingestXGovs"]>[0]) => this.registry.ingestXGovs(args);
  uningestXGovs = (args: Parameters<GGovRegistrySDK["uningestXGovs"]>[0]) => this.registry.uningestXGovs(args);
  uningestCommitteeXGovs = (args: Parameters<GGovRegistrySDK["uningestCommitteeXGovs"]>[0]) =>
    this.registry.uningestCommitteeXGovs(args);
  setXGovRegistryApp = (args: Parameters<GGovRegistrySDK["setXGovRegistryApp"]>[0]) =>
    this.registry.setXGovRegistryApp(args);
  setAdmin = (args: Parameters<GGovRegistrySDK["setAdmin"]>[0]) => this.registry.setAdmin(args);
  getAdmin = () => this.registry.getAdmin();

  // ── Registry: setOperator ────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeSetOperatorTxns({
    account,
    note,
    builder,
  }: GGovRegistryContractArgs["setOperator(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.registryWriteClient!.newGroup();
    return builder.setOperator({ args: { account }, note });
  }

  setOperator = this.makeRegistryTxnExecutor({ maker: this.makeSetOperatorTxns });

  // ── Registry: delegation ─────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeMirrorXGovDelegationTxns({
    account,
    note,
    builder,
  }: GGovRegistryContractArgs["mirrorXGovDelegation(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.registryWriteClient!.newGroup();
    return builder.mirrorXGovDelegation({ args: { account }, note });
  }

  mirrorXGovDelegation = this.makeRegistryTxnExecutor({ maker: this.makeMirrorXGovDelegationTxns });

  /**
   * Set (or clear) an account's voting-power delegation. ABI-compatible with the xGov registry's
   * `set_voting_account`:
   *  - delegate: `setVotingAccount({ votingAddress })`
   *  - clear (vote for self): `setVotingAccount({})` (omitting `votingAddress`)
   *  - manage another account (as its current delegatee): `setVotingAccount({ account, votingAddress })`
   *
   * `account` defaults to the signer (self); `votingAddress` defaults to `account` (clear).
   */
  @requireWriter()
  @wrapErrors()
  makeSetVotingAccountTxns({
    votingAddress,
    account,
    note,
    sender,
    builder,
  }: { votingAddress?: string; account?: string } & CommonMethodBuilderArgs & { sender?: string }) {
    builder = builder ?? this.registryWriteClient!.newGroup();
    const self = sender ?? String(this.writerAccount!.sender);
    const xgovAddress = account ?? self;
    const target = votingAddress ?? xgovAddress; // omitted target == clear ("vote for self")
    const opts: any = { args: { xgovAddress, votingAddress: target }, note };
    if (sender) {
      opts.sender = sender;
      opts.signer = this.algorand.account.getSigner(sender);
    }
    return builder.setVotingAccount(opts);
  }

  setVotingAccount = this.makeRegistryTxnExecutor({ maker: this.makeSetVotingAccountTxns });

  // ── Registry: uploadPeriodApprovalPartial (admin-only bytecode upload) ──

  @requireWriter()
  @wrapErrors()
  makeUploadPeriodApprovalPartialTxns({
    startOffset,
    data,
    last,
    note,
    builder,
  }: {
    startOffset: bigint | number;
    data: Uint8Array;
    last: boolean;
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.registryWriteClient!.newGroup();
    return builder.uploadPeriodApprovalPartial({
      args: { startOffset, data, last },
      note,
    });
  }

  uploadPeriodApprovalPartial = this.makeRegistryTxnExecutor({
    maker: this.makeUploadPeriodApprovalPartialTxns,
  });

  /** Upload the full GGovPeriod approval bytecode, chunked into groups of up to 16 txns. */
  @requireWriter()
  @wrapErrors()
  async uploadPeriodApprovalProgram({
    bytecode,
    note,
  }: {
    bytecode: Uint8Array;
    note?: string | Uint8Array;
  }): Promise<void> {
    const chunks = chunk(Array.from(bytecode), BODY_CHUNK_BYTES);
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    );
    for (const group of groups) {
      let builder: GGovRegistryComposer<any> = this.registryWriteClient!.newGroup();
      for (const { index, data: chunkData } of group) {
        const isLast = index === chunks.length - 1;
        // The maker is @wrapErrors-decorated so it returns a Promise; await to unwrap.
        builder = await this.makeUploadPeriodApprovalPartialTxns({
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          last: isLast,
          note,
          builder,
        });
      }
      await builder.send();
    }
  }

  // ── Registry: addPeriod (paired payment + createPeriod) ──────────

  @requireWriter()
  @wrapErrors()
  async makeAddPeriodTxns({
    committeeId,
    votingStart,
    votingEnd,
    mbrAmount,
    note,
    builder,
  }: {
    committeeId: CommitteeId;
    votingStart: bigint | number;
    votingEnd: bigint | number;
    mbrAmount?: bigint | number;
  } & CommonMethodBuilderArgs) {
    const writer = this.writerAccount!;
    const mbr = BigInt(mbrAmount ?? DEFAULT_PERIOD_MBR_MICROALGOS);
    const mbrPayment = await this.algorand.createTransaction.payment({
      sender: writer.sender,
      receiver: this.registryWriteClient!.appAddress,
      amount: { microAlgo: mbr } as any,
    } as any);
    builder = builder ?? this.registryWriteClient!.newGroup();
    return builder.createPeriod({
      args: {
        committeeId: committeeIdToRaw(committeeId),
        votingStart,
        votingEnd,
        mbrPayment,
      },
      note,
      extraFee: (3000).microAlgo(),
    });
  }

  addPeriod = this.makeRegistryTxnExecutor<typeof this.makeAddPeriodTxns, bigint>({
    maker: this.makeAddPeriodTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? [];
      const tup = returns[returns.length - 1] ?? returns[0];
      const periodId = BigInt(Array.isArray(tup) ? tup[0] : tup);
      const newAppId = BigInt(Array.isArray(tup) ? tup[1] : 0);
      if (newAppId !== 0n) this.periodAppCache.set(periodId, newAppId);
      return periodId;
    },
  });

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
    periodId: bigint | number;
    committeeId: CommitteeId;
    votingStart: bigint | number;
    votingEnd: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.editPeriod({
      args: { committeeId: committeeIdToRaw(committeeId), votingStart, votingEnd },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    });
  }

  editPeriod = this.makePeriodTxnExecutor({ maker: this.makeEditPeriodTxns });

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
    periodId: bigint | number;
    options: string[];
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.addTopic({
      args: { options },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    });
  }

  addTopic = this.makePeriodTxnExecutor<typeof this.makeAddTopicTxns, bigint>({
    maker: this.makeAddTopicTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? [];
      return BigInt(returns[returns.length - 1] ?? returns[0] ?? 0);
    },
  });

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
    periodId: bigint | number;
    topicIndex: bigint | number;
    options: string[];
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.editTopic({
      args: { topicIndex, options },
      note,
      // 1 inner verifyOperator (no summary change)
      extraFee: (1000).microAlgo(),
    });
  }

  editTopic = this.makePeriodTxnExecutor({ maker: this.makeEditTopicTxns });

  // ── Period: uploadPeriodBodyPartial ──────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeUploadPeriodBodyPartialTxns({
    periodId: _periodId,
    startOffset,
    data,
    last,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number;
    startOffset: bigint | number;
    data: Uint8Array;
    last: boolean;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.uploadPeriodBodyPartial({
      args: { startOffset, data, last },
      note,
      extraFee: (1000).microAlgo(),
    });
  }

  uploadPeriodBodyPartial = this.makePeriodTxnExecutor({ maker: this.makeUploadPeriodBodyPartialTxns });

  // ── Period: uploadTopicBodyPartial ───────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeUploadTopicBodyPartialTxns({
    periodId: _periodId,
    topicIndex,
    startOffset,
    data,
    last,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number;
    topicIndex: bigint | number;
    startOffset: bigint | number;
    data: Uint8Array;
    last: boolean;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.uploadTopicBodyPartial({
      args: { topicIndex, startOffset, data, last },
      note,
      extraFee: (1000).microAlgo(),
    });
  }

  uploadTopicBodyPartial = this.makePeriodTxnExecutor({ maker: this.makeUploadTopicBodyPartialTxns });

  /** Upload a full period body, chunked into groups of up to 16 txns. */
  @requireWriter()
  @wrapErrors()
  async uploadPeriodBody({
    periodId,
    body,
    note,
  }: {
    periodId: bigint | number;
    body: BodyJson | string | Uint8Array;
    note?: string | Uint8Array;
  }): Promise<void> {
    const client = await this.getPeriodWriteClient(periodId);
    const data = serializeAndValidateBody(body);
    const chunks = chunk(Array.from(data), BODY_CHUNK_BYTES);
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    );
    for (const group of groups) {
      let builder: GGovPeriodComposer<any> = client.newGroup();
      for (const { index, data: chunkData } of group) {
        const isLast = index === chunks.length - 1;
        builder = await this.makeUploadPeriodBodyPartialTxns({
          periodId,
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          last: isLast,
          note,
          client,
          builder,
        });
      }
      await builder.send();
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
    periodId: bigint | number;
    topicIndex: bigint | number;
    body: BodyJson | string | Uint8Array;
    note?: string | Uint8Array;
  }): Promise<void> {
    const client = await this.getPeriodWriteClient(periodId);
    const data = serializeAndValidateBody(body);
    const chunks = chunk(Array.from(data), BODY_CHUNK_BYTES);
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    );
    for (const group of groups) {
      let builder: GGovPeriodComposer<any> = client.newGroup();
      for (const { index, data: chunkData } of group) {
        const isLast = index === chunks.length - 1;
        builder = await this.makeUploadTopicBodyPartialTxns({
          periodId,
          topicIndex,
          startOffset: index * BODY_CHUNK_BYTES,
          data: new Uint8Array(chunkData),
          last: isLast,
          note,
          client,
          builder,
        });
      }
      await builder.send();
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
    periodId: bigint | number;
    topicIndex: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.removeTopic({
      args: { topicIndex },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary = 2 inner fees
      extraFee: (2000).microAlgo(),
    });
  }

  removeTopic = this.makePeriodTxnExecutor({ maker: this.makeRemoveTopicTxns });

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
    periodId: bigint | number;
    ready: boolean;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.setReady({
      args: { ready },
      note,
      // 1 inner verifyOperator + 1 inner updatePeriodSummary
      extraFee: (2000).microAlgo(),
    });
  }

  setReady = this.makePeriodTxnExecutor({ maker: this.makeSetReadyTxns });

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
  }: GGovPeriodContractArgs["vote(address,uint32[][])void"] & {
    periodId: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();

    const opts: any = {
      args: { voterAccount, topicVotes },
      note,
      // 1 inner getDelegate (when delegated) + 1 inner getXGovVotingPower
      extraFee: (1000).microAlgo(),
    };
    // The sender is always this SDK's writerAccount. Self-vote: writerAccount === voterAccount.
    // Delegated vote: writerAccount is the delegatee and voterAccount is the delegator (someone who
    // delegated to them). In the delegated case the contract requires the delegator to be referenced
    // in the foreign-accounts array so the vote is visible to indexers/explorers; for self-votes it
    // doesn't check, so we omit it. To cast a delegated vote, give the SDK a writerAccount whose
    // signer is the delegatee and pass the delegator as voterAccount.
    const effectiveSender = String(this.writerAccount!.sender);
    if (effectiveSender !== String(voterAccount)) {
      opts.accountReferences = [voterAccount];
      opts.extraFee = (2000).microAlgo(); // +1 inner account ref for delegation check
    }
    return builder.vote(opts);
  }

  vote = this.makePeriodTxnExecutor({ maker: this.makeVoteTxns });

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
    periodId: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.update.bare({
      note,
      // 1 inner verifyAdmin (checkAdminCaller)
      extraFee: (1000).microAlgo(),
    });
  }

  updatePeriodApp = this.makePeriodTxnExecutor({ maker: this.makeUpdatePeriodAppTxns });

  // ── Period: deleteApplication (admin-only, via registry C2C verifyAdmin) ──

  /**
   * Delete a deployed period app. Admin-only (the contract's deleteApplication baremethod
   * inner-calls registry.verifyAdmin). On deletion the AVM closes the period app account and
   * sends its residual ALGO to the deleting sender, so withdraw any meaningful balance first.
   */
  @requireWriter()
  @wrapErrors()
  makeDeletePeriodAppTxns({
    periodId: _periodId,
    note,
    client,
    builder,
  }: {
    periodId: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.delete.bare({
      note,
      // 1 inner verifyAdmin (checkAdminCaller)
      extraFee: (1000).microAlgo(),
    });
  }

  deletePeriodApp = this.makePeriodTxnExecutor({ maker: this.makeDeletePeriodAppTxns });

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
    periodId: bigint | number;
    receiver: string | Address;
    amount: bigint | number;
    client: GGovPeriodClient;
  } & PeriodMethodBuilderArgs) {
    builder = builder ?? client.newGroup();
    return builder.withdrawAlgo({
      args: { receiver: receiver.toString(), amount },
      note,
      // 1 inner verifyAdmin + 1 inner payment
      extraFee: (2000).microAlgo(),
    });
  }

  withdrawPeriodALGO = this.makePeriodTxnExecutor({ maker: this.makeWithdrawPeriodALGOTxns });

  // ── Bootstrap: deploy + fund + upload approval bytecode + optional setup ──

  /**
   * Deploy a fresh `GGovRegistry` app, seed its MBR, upload the GGovPeriod approval
   * bytecode into the registry's approval box, and optionally configure the xGov registry
   * app id and operator account. Returns the writer-enabled SDK bound to the new app.
   *
   * The period bytecode is compiled at runtime from `GGovPeriodFactory`, so the version
   * uploaded matches the version exported by this `ggov-sdk` build.
   */
  static async createRegistry({
    algorand,
    deployer,
    operatorAccount,
    xGovRegistryAppId,
    initialFundingAlgos,
    update = false,
  }: {
    algorand: AlgorandClient;
    deployer: SenderWithSigner;
    operatorAccount?: string | Address;
    xGovRegistryAppId?: bigint | number;
    initialFundingAlgos?: bigint | number;
    update?: boolean
  }): Promise<{ sdk: GGovSDK; appClient: GGovRegistryClient }> {
    const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
      defaultSender: deployer.sender,
      defaultSigner: deployer.signer,
    });
    const { appClient } = await factory.deploy({
      onUpdate: update ? "update" : "append",
      onSchemaBreak: update ? "fail" : "append",
    });

    // Seed the registry's account: covers base MBR + 1 approval box (~3.3 ALGO at 8KB).
    const fundingAlgos = BigInt(initialFundingAlgos ?? 10n);
    await algorand.send.payment({
      sender: deployer.sender,
      receiver: appClient.appAddress,
      amount: fundingAlgos.algo(),
    });

    // Compile the current GGovPeriod approval bytecode (no app deployed; just bytes).
    const periodFactory = algorand.client.getTypedAppFactory(GGovPeriodFactory, {
      defaultSender: deployer.sender,
      defaultSigner: deployer.signer,
    });
    const compiled = await periodFactory.appFactory.compile();

    const sdk = new GGovSDK({
      algorand,
      registryAppId: appClient.appId,
      writerAccount: deployer,
    });

    await sdk.uploadPeriodApprovalProgram({ bytecode: compiled.approvalProgram });

    if (xGovRegistryAppId !== undefined) {
      await sdk.setXGovRegistryApp({ appId: BigInt(xGovRegistryAppId) });
    }
    if (operatorAccount !== undefined) {
      const op = typeof operatorAccount === "string" ? operatorAccount : operatorAccount.toString();
      await sdk.setOperator({ account: op });
    }

    return { sdk, appClient };
  }
}

function serializeAndValidateBody(body: BodyJson | string | Uint8Array): Uint8Array {
  if (typeof body === "object" && !(body instanceof Uint8Array)) {
    if (!validateBodyJson(body)) {
      throw new Error("Body must have 'title' (string) and 'body' (string) fields");
    }
    return new TextEncoder().encode(JSON.stringify(body));
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Body must be valid JSON with 'title' (string) and 'body' (string) fields");
  }
  if (!validateBodyJson(parsed)) {
    throw new Error("Body must have 'title' (string) and 'body' (string) fields");
  }
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
