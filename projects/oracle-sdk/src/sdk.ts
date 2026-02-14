import { CommitteeOracleClient } from "./generated/CommitteeOracleClient";
import {
  ConstructorArgs,
  AccountWithVotes,
  SenderWithSigner,
  XGovCommitteeFile,
  CommonMethodBuilderArgs,
  OracleContractArgs,
} from "./types";
import { requireWriter } from "./util/requiresSender";
import { calculateCommitteeId } from "./util/comitteeId";
import { xGovToTuple } from "./util/types";
import { XGovCommitteesOracleReaderSDK } from "./sdkReader";
import { wrapErrors, wrapErrorsInternal } from "./util/wrapErrors";
import { createTxnExecutor } from "./util/txnExecutor";
import { chunk } from "./util/chunk";

export class XGovCommitteesOracleSDK extends XGovCommitteesOracleReaderSDK {
  public writerAccount?: SenderWithSigner;
  public writeClient?: CommitteeOracleClient;

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest);
    if (writerAccount) {
      this.writerAccount = writerAccount;
      this.writeClient = new CommitteeOracleClient({
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
  }: Omit<OracleContractArgs["registerCommittee(byte[32],uint32,uint32,uint32,uint32,uint64)void"], "committeeId"> & {
    committeeId: string | Uint8Array;
  } & CommonMethodBuilderArgs) {
    committeeId = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    const { sender, signer } = this.writerAccount!;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.registerCommittee({
      args: { committeeId, periodStart, periodEnd, totalMembers, totalVotes, xGovRegistryId },
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
    committeeId = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    const { sender, signer } = this.writerAccount!;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.unregisterCommittee({
      args: { committeeId },
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
    committeeId = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    builder = builder ?? this.writeClient!.newGroup();
    const xGovChunks = chunk(xGovs, 8);
    if (xGovChunks.length > 15) {
      throw new Error(`Too many xGovs to ingest in one transaction group: ${xGovs.length} (max 120)`);
    }
    for (const xGovs of xGovChunks)
      builder = builder.ingestXGovs({
        args: { committeeId, xGovs: xGovs.map(xGovToTuple) },
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
  makeSetXGovRegistryAppTxns({ appId, builder }: OracleContractArgs["setXGovRegistryApp(uint64)void"] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup();
    builder = builder.setXGovRegistryApp({ args: { appId } });
    return builder;
  }

  setXGovRegistryApp = this.makeTxnExecutor({
    maker: this.makeSetXGovRegistryAppTxns,
  });

  @requireWriter()
  @wrapErrors()
  makeUningestXGovsTxns({
    committeeId,
    xGovs,
    builder,
  }: Omit<OracleContractArgs["uningestXGovs(byte[32],address[])void"], "committeeId"> & {
    committeeId: string | Uint8Array;
  } & CommonMethodBuilderArgs) {
    const { sender, signer } = this.writerAccount!;
    committeeId = typeof committeeId === "string" ? Buffer.from(committeeId, "base64") : committeeId;
    builder = builder ?? this.writeClient!.newGroup();
    return builder.uningestXGovs({
      args: { committeeId, xGovs },
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

    const oracleAccountsMap = await this.getOracleAccountsMap(accounts);

    // sort by committee offset descending (reverse ingestion order)
    const sorted = accounts
      .map((address) => {
        const oracleAccount = oracleAccountsMap.get(address);
        if (!oracleAccount || oracleAccount.accountId === 0) {
          throw new Error(`Account ${address} not found in oracle`);
        }
        const offsetEntry = oracleAccount.committeeOffsets.find(([cId]) => cId === numericId);
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
}
