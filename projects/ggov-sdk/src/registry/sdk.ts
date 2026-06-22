import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Address } from "algosdk";
import { GGovRegistryClient, GGovRegistryComposer, GGovRegistryFactory } from "../generated/GGovRegistryClient";
import { APP_SPEC as PERIOD_APP_SPEC } from "../generated/GGovPeriodClient";
import {
  ConstructorArgs,
  AccountWithVotes,
  SenderWithSigner,
  CommitteeId,
  XGovCommitteeFile,
  CommonMethodBuilderArgs,
  GGovRegistryContractArgs,
} from "./types";
import { requireWriter } from "../util/requiresSender";
import { calculateCommitteeId, committeeIdToRaw } from "../util/comitteeId";
import { xGovToTuple } from "./xGov";
import { GGovRegistryReaderSDK } from "./sdkReader";
import { wrapErrors, wrapErrorsInternal } from "../util/wrapErrors";
import { createTxnExecutor } from "../util/txnExecutor";
import { chunk } from "../util/chunk";
import { MAX_GROUP_SIZE, BODY_CHUNK_BYTES, DEFAULT_PERIOD_MBR_MICROALGOS } from "../constants";

export class GGovRegistrySDK extends GGovRegistryReaderSDK {
  public writerAccount?: SenderWithSigner;
  public writeClient?: GGovRegistryClient;

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest);
    if (writerAccount) {
      this.writerAccount = writerAccount;
      this.writeClient = new GGovRegistryClient({
        algorand: this.algorand,
        appId: this.appId,
        defaultSender: writerAccount?.sender,
        defaultSigner: writerAccount?.signer,
      });
    }
  }

  private makeTxnExecutor = createTxnExecutor(
    this,
    () => this.writeClient!.newGroup(),
    wrapErrorsInternal,
    () => this.writerAccount,
    () => this.algorand.client.algod,
  );

  @requireWriter()
  @wrapErrors()
  async uploadCommitteeFile(committeeFile: XGovCommitteeFile): Promise<Uint8Array> {
    const committeeId = calculateCommitteeId(JSON.stringify(committeeFile));
    const committeeMetadata = await this.getCommitteeMetadata(committeeId);
    if (!committeeMetadata) {
      this.debug && console.log("Registering committee...");
      const { registryId: xGovRegistryId, ...rest } = committeeFile;
      const { txIds } = await this.registerCommittee({ committeeId, xGovRegistryId, ...rest });
      this.debug && console.log("Committee registered ", ...txIds);
    }
    const accounts = committeeFile.xGovs.map(({ address }) => address);
    const [accountIds, lastIngestedXGov] = await Promise.all([
      this.getAccountIdMap(accounts),
      this.getCommitteeSuperboxDataLast(committeeId),
    ]);

    // order accounts, increasing IDs and zero IDs last
    const accountsInOrder = [...accountIds.entries()]
      .map(([address, id]) => ({ address, id }))
      .sort(({ id: a }, { id: b }) => (a === 0 && b !== 0 ? 1 : a !== 0 && b === 0 ? -1 : a - b));

    this.debug && console.log({ acctLen: accountsInOrder.length, lastIngestedXGov });
    if (lastIngestedXGov.total) {
      const expectedLastId = accountsInOrder[lastIngestedXGov.total - 1].id;
      if (lastIngestedXGov.last && lastIngestedXGov.last[0] !== expectedLastId) {
        throw new Error(`Last ingested xGov ID ${lastIngestedXGov.last[0]} does not match expected ID ${expectedLastId}`);
        // TODO get xGovs, compare with accountsInOrder, uningest as necessary, resume ingestion
      }
    }
    const accountsToIngest = accountsInOrder.slice(lastIngestedXGov.total ? lastIngestedXGov.total : 0);
    const chunks = chunk(accountsToIngest, 120);
    this.debug && console.log(`Ingesting ${accountsToIngest.length} xGovs in ${chunks.length} chunks...`);
    for (const accountsChunk of chunks) {
      const xGovs = accountsChunk.map(({ id, address }) => ({
        accountId: id,
        account: address,
        votes: committeeFile.xGovs.find((x) => x.address === address)!.votes,
      }));
      const { txIds } = await this.ingestXGovs({ committeeId, xGovs });
      const accountsLog = accountsChunk.map(({ address }) => address.slice(0, 8) + "..").join(" ");
      this.debug && console.log("xGov ingested ", accountsLog, txIds[txIds.length - 1]);
    }
    return committeeId;
  }

  @requireWriter()
  @wrapErrors()
  makeRegisterCommitteeTxns({
    committeeId,
    periodStart,
    periodEnd,
    totalMembers,
    totalVotes,
    xGovRegistryId,
    builder,
  }: Omit<GGovRegistryContractArgs["registerCommittee(byte[32],uint32,uint32,uint32,uint32,uint64)void"], "committeeId"> & {
    committeeId: string | Uint8Array;
  } & CommonMethodBuilderArgs) {
    const committeeRaw = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    const { sender, signer } = this.writerAccount!;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.registerCommittee({
      args: { committeeId: committeeRaw, periodStart, periodEnd, totalMembers, totalVotes, xGovRegistryId },
      sender,
      signer,
    });
  }

  registerCommittee = this.makeTxnExecutor({
    maker: this.makeRegisterCommitteeTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUnregisterCommitteeTxns({ committeeId, builder }: { committeeId: string | Uint8Array } & CommonMethodBuilderArgs) {
    const committeeRaw = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    const { sender, signer } = this.writerAccount!;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.unregisterCommittee({
      args: { committeeId: committeeRaw },
      sender,
      signer,
    });
  }

  unregisterCommittee = this.makeTxnExecutor({
    maker: this.makeUnregisterCommitteeTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeIngestXGovsTxns({
    committeeId,
    xGovs,
    builder,
  }: { committeeId: string | Uint8Array; xGovs: AccountWithVotes[] } & CommonMethodBuilderArgs) {
    const { sender, signer } = this.writerAccount!;
    const committeeRaw = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    builder = builder ?? this.writeClient!.newGroup();
    const xGovChunks = chunk(xGovs, 8);
    if (xGovChunks.length > 15) {
      throw new Error(`Too many xGovs to ingest in one transaction group: ${xGovs.length} (max 120)`);
    }
    for (const xGovs of xGovChunks)
      builder = builder.ingestXGovs({
        args: { committeeId: committeeRaw, xGovs: xGovs.map(xGovToTuple) },
        sender,
        signer,
      });
    return builder;
  }

  ingestXGovs = this.makeTxnExecutor({
    maker: this.makeIngestXGovsTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeSetXGovRegistryAppTxns({ appId, builder }: GGovRegistryContractArgs["setXGovRegistryApp(uint64)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    builder = builder.setXGovRegistryApp({ args: { appId } });
    return builder;
  }

  setXGovRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetXGovRegistryAppTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeSetOperatorTxns({ account, builder }: GGovRegistryContractArgs["setOperator(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    builder = builder.setOperator({ args: { account } });
    return builder;
  }

  setOperator = this.makeTxnExecutor({
    maker: this.makeSetOperatorTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeSetLastPeriodIdTxns({ newLastPeriodId, builder }: GGovRegistryContractArgs["setLastPeriodId(uint64)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    // A downward move reads the period boxes in the reclaimed range; AlgoKit populates the
    // box references automatically. A forward seed (the legacy case) reads no boxes.
    builder = builder.setLastPeriodId({ args: { newLastPeriodId } });
    return builder;
  }

  setLastPeriodId = this.makeTxnExecutor({
    maker: this.makeSetLastPeriodIdTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeSetAdminTxns({ newAdmin, builder }: GGovRegistryContractArgs["setAdmin(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    builder = builder.setAdmin({ args: { newAdmin } });
    return builder;
  }

  setAdmin = this.makeTxnExecutor({
    maker: this.makeSetAdminTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeWithdrawALGOTxns({
    receiver,
    amount,
    builder,
  }: GGovRegistryContractArgs["withdrawALGO(address,uint64)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    // extraFee covers the single inner payment
    builder = builder.withdrawAlgo({ args: { receiver, amount }, extraFee: (1000).microAlgo() });
    return builder;
  }

  withdrawALGO = this.makeTxnExecutor({
    maker: this.makeWithdrawALGOTxns,
  });

  /**
   * Delete the GGovRegistry app. Admin-only (the contract's deleteApplication baremethod
   * checks the caller is the admin directly — no inner call). On deletion the AVM closes the
   * registry app account and sends its residual ALGO to the deleting sender, so withdraw any
   * meaningful balance first.
   */
  @requireWriter()
  @wrapErrors()
  makeDeleteApplicationTxns({ builder }: CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    builder = builder.delete.bare({});
    return builder;
  }

  deleteApplication = this.makeTxnExecutor({
    maker: this.makeDeleteApplicationTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUningestXGovsTxns({
    committeeId,
    xGovs,
    builder,
  }: Omit<GGovRegistryContractArgs["uningestXGovs(byte[32],address[])void"], "committeeId"> & {
    committeeId: string | Uint8Array;
  } & CommonMethodBuilderArgs) {
    const { sender, signer } = this.writerAccount!;
    const committeeRaw = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.uningestXGovs({
      args: { committeeId: committeeRaw, xGovs },
      sender,
      signer,
    });
  }

  uningestXGovs = this.makeTxnExecutor({
    maker: this.makeUningestXGovsTxns,
  });

  /**
   * Uningest xGovs from a committee in reverse ingestion order.
   * Looks up each account's committee offset, sorts descending, and sends sequentially.
   * @param committeeId Committee ID
   * @param accounts Accounts to uningest (in any order - will be sorted internally)
   */
  @requireWriter()
  @wrapErrors()
  async uningestCommitteeXGovs({ committeeId, accounts }: { committeeId: string | Uint8Array; accounts: string[] }): Promise<void> {
    const metadata = await this.getCommitteeMetadata(committeeId);
    if (!metadata) throw new Error("Committee not found");
    const numericId = metadata.numericId;

    const gGovAccountsMap = await this.getGGovAccountsMap(accounts);

    // sort by committee offset descending (reverse ingestion order)
    const sorted = accounts
      .map((address) => {
        const gGovAccount = gGovAccountsMap.get(address);
        if (!gGovAccount || gGovAccount.accountId === 0) {
          throw new Error(`Account ${address} not found in gGov registry`);
        }
        const offsetEntry = gGovAccount.committeeOffsets.find(([cId]) => cId === numericId);
        if (!offsetEntry) {
          throw new Error(`Account ${address} has no offset for committee numericId ${numericId}`);
        }
        return { address, offset: offsetEntry[1] };
      })
      .sort((a, b) => b.offset - a.offset);

    // send sequentially in chunks - strict reverse order required
    const chunks = chunk(sorted, 8);
    for (const accountsChunk of chunks) {
      await this.uningestXGovs({ committeeId, xGovs: accountsChunk.map(({ address }) => address) });
      this.debug && console.log("Uningest chunk:", accountsChunk.map(({ address }) => address.slice(0, 8) + "..").join(" "));
    }
  }

  // ── Delegation ───────────────────────────────────────────────────

  @requireWriter()
  @wrapErrors()
  makeMirrorXGovDelegationTxns({
    account,
    note,
    builder,
  }: GGovRegistryContractArgs["mirrorXGovDelegation(address)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    return builder.mirrorXGovDelegation({ args: { account }, note });
  }

  mirrorXGovDelegation = this.makeTxnExecutor({ maker: this.makeMirrorXGovDelegationTxns });

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
    builder = builder ?? this.writeClient!.newGroup();
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

  setVotingAccount = this.makeTxnExecutor({ maker: this.makeSetVotingAccountTxns });

  // ── Period bytecode upload (admin-only) ──────────────────────────

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
    builder = builder ?? this.writeClient!.newGroup();
    return builder.uploadPeriodApprovalPartial({
      args: { startOffset, data, last },
      note,
    });
  }

  uploadPeriodApprovalPartial = this.makeTxnExecutor({
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
      let builder: GGovRegistryComposer<any> = this.writeClient!.newGroup();
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

  // ── addPeriod (paired payment + createPeriod) ────────────────────

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
      receiver: this.writeClient!.appAddress,
      amount: { microAlgo: mbr } as any,
    } as any);
    builder = builder ?? this.writeClient!.newGroup();
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

  addPeriod = this.makeTxnExecutor<typeof this.makeAddPeriodTxns, bigint>({
    maker: this.makeAddPeriodTxns,
    returnTransformer: (result) => {
      const returns = (result as any).returns ?? [];
      const tup = returns[returns.length - 1] ?? returns[0];
      return BigInt(Array.isArray(tup) ? tup[0] : tup);
    },
  });

  // ── Bootstrap: deploy + fund + upload period bytecode + optional setup ──

  /**
   * Deploy a fresh `GGovRegistry` app, seed its MBR, upload the GGovPeriod approval bytecode
   * into the registry's approval box, and optionally configure the xGov registry app id and
   * operator account. Returns the writer-enabled registry SDK bound to the new app.
   *
   * The period approval bytecode comes from the generated `GGovPeriodClient` app spec
   * (`PERIOD_APP_SPEC.byteCode.approval`), so the version uploaded matches this build.
   */
  static async createRegistry({
    algorand,
    deployer,
    operatorAccount,
    xGovRegistryAppId,
    initialFundingAlgos,
    firstPeriodId,
    update = false,
  }: {
    algorand: AlgorandClient;
    deployer: SenderWithSigner;
    operatorAccount?: string | Address;
    xGovRegistryAppId?: bigint | number;
    initialFundingAlgos?: bigint | number;
    /**
     * Id to assign to the first period created on this registry. Use to continue numbering
     * contiguously after a legacy system (e.g. 16 to follow legacy periods 1..15). Seeds the
     * registry's period counter to firstPeriodId - 1; omit to start at 1.
     */
    firstPeriodId?: bigint | number;
    update?: boolean;
  }): Promise<{ sdk: GGovRegistrySDK; appClient: GGovRegistryClient }> {
    const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
      defaultSender: deployer.sender,
      defaultSigner: deployer.signer,
    });
    const { appClient } = await factory.deploy({
      onUpdate: update ? "update" : "append",
      onSchemaBreak: update ? "fail" : "append",
      createParams: {
        extraProgramPages: 3,
      },
    });

    // Seed the registry's account: covers base MBR + 1 approval box (~3.3 ALGO at 8KB).
    const fundingAlgos = BigInt(initialFundingAlgos ?? 10n);
    await algorand.send.payment({
      sender: deployer.sender,
      receiver: appClient.appAddress,
      amount: fundingAlgos.algo(),
    });

    if (!PERIOD_APP_SPEC.byteCode?.approval) {
      throw new Error("GGovPeriod approval bytecode is not available. Was the generated client built with minimal build options?");
    }
    const bytecode = Buffer.from(PERIOD_APP_SPEC.byteCode.approval, "base64");

    const sdk = new GGovRegistrySDK({
      algorand,
      registryAppId: appClient.appId,
      writerAccount: deployer,
    });

    await sdk.uploadPeriodApprovalProgram({ bytecode });

    if (firstPeriodId !== undefined) {
      // Seed the counter so the first createPeriod issues firstPeriodId. Done before setOperator,
      // and the operator is the only role that can create periods, so no period can be created
      // in between.
      await sdk.setLastPeriodId({ newLastPeriodId: BigInt(firstPeriodId) - 1n });
    }

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
