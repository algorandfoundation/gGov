import { GGovClient, GGovComposer } from "./generated/GGovClient";
import { GGovReaderSDK } from "./sdkReader";
import { createTxnExecutor } from "xgov-committees-oracle-sdk";
import {
  BodyJson,
  CommitteeId,
  CommonMethodBuilderArgs,
  ConstructorArgs,
  GGovContractArgs,
  validateBodyJson,
} from "./types";
import { requireWriter } from "./util/requiresSender";
import { wrapErrors, wrapErrorsInternal } from "./util/wrapErrors";
import { committeeIdToRaw } from "./util/comitteeId";
import { chunk } from "./util/chunk";

/** Algorand atomic group transaction limit. */
const MAX_GROUP_SIZE = 16;

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
  makeSetOperatorTxns({ account, note, builder }: GGovContractArgs["setOperator(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.setOperator({ args: { account }, note });
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
    note,
    builder,
  }: Omit<GGovContractArgs["addPeriod(byte[32],uint64,uint64)uint64"], "committeeId"> & {
    committeeId: CommitteeId;
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.addPeriod({
      args: { committeeId: committeeIdToRaw(committeeId), votingStart, votingEnd },
      note,
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
    committeeId,
    periodId,
    votingStart,
    votingEnd,
    note,
    builder,
  }: Omit<GGovContractArgs["editPeriod(uint64,byte[32],uint64,uint64)void"], "committeeId"> & {
    committeeId: CommitteeId;
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.editPeriod({ args: { periodId, committeeId: committeeIdToRaw(committeeId), votingStart, votingEnd }, note });
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
    note,
    builder,
  }: GGovContractArgs["uploadPeriodBodyPartial(uint64,uint64,byte[],bool)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.uploadPeriodBodyPartial({ args: { periodId, startOffset, data, last }, note });
    return builder;
  }

  uploadPeriodBodyPartial = this.makeGGovTxnExecutor({
    maker: this.makeUploadPeriodBodyPartialTxns,
  });

  /**
   * Upload a full period body, chunked automatically.
   * Accepts a BodyJson object ({ title, body }) or a pre-serialized string/Uint8Array.
   * When a string or Uint8Array is provided it is validated against the { title, body } schema.
   * Chunks are batched into atomic groups of up to 16 transactions for efficiency.
   */
  @requireWriter()
  @wrapErrors()
  async uploadPeriodBody({ periodId, body, note }: { periodId: bigint | number; body: BodyJson | string | Uint8Array; note?: string | Uint8Array }): Promise<void> {
    const data = serializeAndValidateBody(body);
    const chunks = chunk(Array.from(data), 2000);
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    );
    for (const group of groups) {
      let builder: GGovComposer<any> = this.ggovWriteClient!.newGroup();
      for (const { index, data: chunkData } of group) {
        const isLast = index === chunks.length - 1;
        builder = builder.uploadPeriodBodyPartial({
          args: { periodId, startOffset: index * 2000, data: new Uint8Array(chunkData), last: isLast },
          note,
        });
      }
      await builder.send();
    }
  }

  // ── Operator: Topic CRUD ──────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeAddTopicTxns({
    periodId,
    options,
    note,
    builder,
  }: GGovContractArgs["addTopic(uint64,string[])uint64"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.addTopic({ args: { periodId, options }, note });
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
    note,
    builder,
  }: GGovContractArgs["editTopic(uint64,uint64,string[])void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.editTopic({ args: { periodId, topicIndex, options }, note });
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
    note,
    builder,
  }: GGovContractArgs["uploadTopicBodyPartial(uint64,uint64,uint64,byte[],bool)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    builder = builder.uploadTopicBodyPartial({ args: { periodId, topicIndex, startOffset, data, last }, note });
    return builder;
  }

  uploadTopicBodyPartial = this.makeGGovTxnExecutor({
    maker: this.makeUploadTopicBodyPartialTxns,
  });

  /**
   * Upload a full topic body, chunked automatically.
   * Accepts a BodyJson object ({ title, body }) or a pre-serialized string/Uint8Array.
   * When a string or Uint8Array is provided it is validated against the { title, body } schema.
   * Chunks are batched into atomic groups of up to 16 transactions for efficiency.
   */
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
    const data = serializeAndValidateBody(body);
    const chunks = chunk(Array.from(data), 2000);
    const groups = chunk(
      chunks.map((c, i) => ({ index: i, data: c })),
      MAX_GROUP_SIZE,
    );
    for (const group of groups) {
      let builder: GGovComposer<any> = this.ggovWriteClient!.newGroup();
      for (const { index, data: chunkData } of group) {
        const isLast = index === chunks.length - 1;
        builder = builder.uploadTopicBodyPartial({
          args: { periodId, topicIndex, startOffset: index * 2000, data: new Uint8Array(chunkData), last: isLast },
          note,
        });
      }
      await builder.send();
    }
  }

  // ── Delegation ───────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeDelegateTxns({
    delegatee,
    note,
    sender,
    builder,
  }: GGovContractArgs["delegate(address)void"] & CommonMethodBuilderArgs & { sender?: string }) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const delegateArgs: any = { args: { delegatee }, note };
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
  makeUndelegateTxns({ note, sender, builder }: CommonMethodBuilderArgs & { sender?: string } = {}) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const undelegateArgs: any = { args: {}, note };
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
    note,
    sender,
    builder,
  }: GGovContractArgs["vote(uint64,address,uint64[][])void"] & CommonMethodBuilderArgs & { sender?: string }) {
    builder = builder ?? this.ggovWriteClient!.newGroup();
    const voteArgs: any = { args: { periodId, voterAccount, topicVotes }, note };
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

function serializeAndValidateBody(body: BodyJson | string | Uint8Array): Uint8Array {
  if (typeof body === "object" && !(body instanceof Uint8Array)) {
    // BodyJson object - validate and serialize
    if (!validateBodyJson(body)) {
      throw new Error("Body must have 'title' (string) and 'body' (string) fields");
    }
    return new TextEncoder().encode(JSON.stringify(body));
  }
  // string or Uint8Array - parse and validate schema
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
