import { GGovClient } from "./generated/GGovClient";
import { GGovReaderSDK } from "./sdkReader";
import { createTxnExecutor } from "xgov-committees-oracle-sdk";
import {
  CommitteeId,
  CommonMethodBuilderArgs,
  ConstructorArgs,
  GGovContractArgs,
} from "./types";
import { requireWriter } from "./util/requiresSender";
import { wrapErrors, wrapErrorsInternal } from "./util/wrapErrors";
import { committeeIdToRaw } from "./util/comitteeId";
import { chunk } from "./util/chunk";

export class GGovSDK extends GGovReaderSDK {
  public ggovWriteClient?: GGovClient;

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super({ ...rest, writerAccount });
    if (writerAccount) {
      this.ggovWriteClient = new GGovClient({
        algorand: this.algorand,
        appId: this.appId,
        defaultSender: writerAccount?.sender,
        defaultSigner: writerAccount?.signer,
      });
    }
  }

  private makeGGovTxnExecutor = createTxnExecutor(
    this,
    () => this.ggovWriteClient!.newGroup(),
    wrapErrorsInternal,
    () => this.writerAccount,
    () => this.algorand.client.algod,
  );

  // ── Admin methods ────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeSetOperatorTxns({ account, builder }: GGovContractArgs["setOperator(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.setOperator({ args: { account } });
    return builder;
  }

  setOperator = this.makeGGovTxnExecutor({
    maker: this.makeSetOperatorTxns,
  });

  // ── Operator: Period CRUD ────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeAddPeriodTxns({
    committeeId,
    votingStart,
    votingEnd,
    builder,
  }: Omit<GGovContractArgs["addPeriod(byte[32],uint64,uint64)uint64"], "committeeId"> & {
    committeeId: CommitteeId;
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.addPeriod({
      args: { committeeId: committeeIdToRaw(committeeId), votingStart, votingEnd },
    });
    return builder;
  }

  addPeriod = this.makeGGovTxnExecutor({
    maker: this.makeAddPeriodTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns;
      return (returns?.[returns.length - 1] ?? returns?.[0]) as bigint;
    },
  });

  @requireWriter()
  @wrapErrors()
  makeEditPeriodTxns({
    periodId,
    votingStart,
    votingEnd,
    builder,
  }: GGovContractArgs["editPeriod(uint64,uint64,uint64)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.editPeriod({ args: { periodId, votingStart, votingEnd } });
    return builder;
  }

  editPeriod = this.makeGGovTxnExecutor({
    maker: this.makeEditPeriodTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUploadPeriodBodyPartialTxns({
    periodId,
    startOffset,
    data,
    last,
    builder,
  }: GGovContractArgs["uploadPeriodBodyPartial(uint64,uint64,byte[],bool)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.uploadPeriodBodyPartial({ args: { periodId, startOffset, data, last } });
    return builder;
  }

  uploadPeriodBodyPartial = this.makeGGovTxnExecutor({
    maker: this.makeUploadPeriodBodyPartialTxns,
  });

  /**
   * Upload a full period body JSON string, chunked automatically.
   * @param periodId Period ID
   * @param body JSON string or Uint8Array to upload
   */
  @requireWriter()
  @wrapErrors()
  async uploadPeriodBody({ periodId, body }: { periodId: bigint | number; body: string | Uint8Array }): Promise<void> {
    const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const chunks = chunk(Array.from(data), 2000);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.uploadPeriodBodyPartial({
        periodId,
        startOffset: i * 2000,
        data: new Uint8Array(chunks[i]),
        last: isLast,
      });
    }
  }

  // ── Operator: Topic CRUD ──────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeAddTopicTxns({
    periodId,
    options,
    builder,
  }: GGovContractArgs["addTopic(uint64,string[])uint64"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.addTopic({ args: { periodId, options } });
    return builder;
  }

  addTopic = this.makeGGovTxnExecutor({
    maker: this.makeAddTopicTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns;
      return (returns?.[returns.length - 1] ?? returns?.[0]) as bigint;
    },
  });

  @requireWriter()
  @wrapErrors()
  makeEditTopicTxns({
    periodId,
    topicIndex,
    options,
    builder,
  }: GGovContractArgs["editTopic(uint64,uint64,string[])void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.editTopic({ args: { periodId, topicIndex, options } });
    return builder;
  }

  editTopic = this.makeGGovTxnExecutor({
    maker: this.makeEditTopicTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUploadTopicBodyPartialTxns({
    periodId,
    topicIndex,
    startOffset,
    data,
    last,
    builder,
  }: GGovContractArgs["uploadTopicBodyPartial(uint64,uint64,uint64,byte[],bool)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.uploadTopicBodyPartial({ args: { periodId, topicIndex, startOffset, data, last } });
    return builder;
  }

  uploadTopicBodyPartial = this.makeGGovTxnExecutor({
    maker: this.makeUploadTopicBodyPartialTxns,
  });

  /**
   * Upload a full topic body JSON string, chunked automatically.
   */
  @requireWriter()
  @wrapErrors()
  async uploadTopicBody({
    periodId,
    topicIndex,
    body,
  }: {
    periodId: bigint | number;
    topicIndex: bigint | number;
    body: string | Uint8Array;
  }): Promise<void> {
    const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const chunks = chunk(Array.from(data), 2000);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.uploadTopicBodyPartial({
        periodId,
        topicIndex,
        startOffset: i * 2000,
        data: new Uint8Array(chunks[i]),
        last: isLast,
      });
    }
  }

  // ── Delegation ───────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeDelegateTxns({
    delegatee,
    sender,
    builder,
  }: GGovContractArgs["delegate(address)void"] & CommonMethodBuilderArgs & { sender?: string }) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const delegateArgs: any = { args: { delegatee } };
    if (sender) {
      delegateArgs.sender = sender;
      delegateArgs.signer = this.algorand.account.getSigner(sender);
    }
    builder = builder.delegate(delegateArgs);
    return builder;
  }

  delegate = this.makeGGovTxnExecutor({
    maker: this.makeDelegateTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUndelegateTxns({ sender, builder }: CommonMethodBuilderArgs & { sender?: string } = {}) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const undelegateArgs: any = { args: {} };
    if (sender) {
      undelegateArgs.sender = sender;
      undelegateArgs.signer = this.algorand.account.getSigner(sender);
    }
    builder = builder.undelegate(undelegateArgs);
    return builder;
  }

  undelegate = this.makeGGovTxnExecutor({
    maker: this.makeUndelegateTxns,
  });

  // ── Voting ───────────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeVoteTxns({
    periodId,
    voterAccount,
    topicVotes,
    sender,
    builder,
  }: GGovContractArgs["vote(uint64,address,uint64[][])void"] & CommonMethodBuilderArgs & { sender?: string }) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const voteArgs: any = { args: { periodId, voterAccount, topicVotes } };
    if (sender) {
      voteArgs.sender = sender;
      voteArgs.signer = this.algorand.account.getSigner(sender);
    }
    builder = builder.vote(voteArgs);
    return builder;
  }

  vote = this.makeGGovTxnExecutor({
    maker: this.makeVoteTxns,
  });
}
