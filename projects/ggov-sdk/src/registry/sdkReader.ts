import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getABIDecodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { ALGORAND_ZERO_ADDRESS_STRING, encodeAddress, makeEmptyTransactionSigner } from "algosdk";
import pMap from "p-map";
import { CommitteeMetadata, GGovRegistryClient, GGovRegistryComposer, GGovAccount, SuperboxMeta } from "../generated/GGovRegistryClient";
import { getConstructorConfig } from "../networkConfig";
import { CommitteeId, AccountWithVotes, ReaderConstructorArgs, STORED_XGOV_BYTE_LENGTH, StoredXGov, XGovCommitteeFile } from "./types";
import { chunk } from "../util/chunk";
import { chunked } from "../util/chunked";
import { committeeIdToRaw } from "../util/comitteeId";
import { errorTransformer, wrapErrors } from "../util/wrapErrors";
import { SIMULATE_PARAMS } from "../util/increaseBudget";

const PARTIAL_COMMITTEE_SIMULATE_CALLS = 16; // 16 simulate calls per fast-get
const PARTIAL_COMMITTEE_FIRST_DATA_PAGE_LENGTH = 6; // first fast-get call retrieves 6 data pages, because 2x refs needed for sb meta + committee meta
const PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH = 7; // subsequent calls retrieve 7 data pages, because 1x ref needed for sb meta

export class GGovRegistryReaderSDK {
  public algorand: AlgorandClient;
  public appId: bigint;
  public readClient: GGovRegistryClient;
  public concurrency: number;
  public debug?: boolean;

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest);
    this.algorand = algorand;
    algorand.setSuggestedParamsCacheTimeout(6000); // 6s or ~2 rounds of cache. reduces GET requests to /params
    algorand.registerErrorTransformer(errorTransformer);
    this.appId = appId;
    this.concurrency = concurrency;
    this.debug = debug;
    this.readClient = new GGovRegistryClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    });
  }

  /**
   * Get committee the reasonable way, fetching metadata, then superbox metadata, then xgovs sequentially
   * @param committeeId
   * @returns
   */
  @wrapErrors()
  async getCommittee(committeeId: CommitteeId): Promise<XGovCommitteeFile | null> {
    const committeeMetadata = await this.getCommitteeMetadata(committeeId, true);
    if (!committeeMetadata) return null;
    const xGovs = await this.getCommitteeXGovs(committeeId);
    const params = await this.algorand.getSuggestedParams();
    const networkGenesisHash = Buffer.from(params.genesisHash!).toString("base64");
    // TODO validate committee ID
    return {
      networkGenesisHash,
      periodEnd: committeeMetadata.periodEnd,
      periodStart: committeeMetadata.periodStart,
      registryId: Number(committeeMetadata.xGovRegistryId),
      totalMembers: committeeMetadata.totalMembers,
      totalVotes: committeeMetadata.totalVotes,
      xGovs: xGovs.map(({ account, votes }) => ({ address: account.toString(), votes })),
    };
  }

  /**
   * Get committee with parallel calls and simulate heroics
   * @param committeeId
   * @returns
   */
  @wrapErrors()
  async fastGetCommittee(committeeId: CommitteeId, { includeBoxOrder }: { includeBoxOrder?: boolean } = {}): Promise<XGovCommitteeFile & { xGovBoxOrder?: string[] } | null> {
    const firstPartialCommitteeDataPromise = this.fastGetPartialCommitteeData(committeeId, 0);
    const accountIdMapPromise = this.getAccountIdMap();

    const { committeeMetadata, storedXGovs, lastDataPage, totalDataPages } = await firstPartialCommitteeDataPromise;
    // fetch rest if needed
    // 6 + 15 * 7 = 111 data boxes on first fastGet call, 2048 sized boxes, 227328 bytes total, 8 bytes per xgov: 28416 xgovs needed to require a second fastGet page
    const nextDataPage = lastDataPage + 1;
    if (nextDataPage < totalDataPages) {
      const partialFetchDataSize = PARTIAL_COMMITTEE_SIMULATE_CALLS * PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH;
      const extraCalls = Math.ceil((totalDataPages! - nextDataPage) / partialFetchDataSize);
      const arr = Array.from({ length: extraCalls }, (_, i) => nextDataPage + i * partialFetchDataSize);
      await pMap(
        arr,
        (pageStart) => this.fastGetPartialCommitteeData(committeeId, pageStart).then((data) => storedXGovs.push(...data.storedXGovs)),
        { concurrency: this.concurrency },
      );
    }

    const accountIdMap = await accountIdMapPromise;
    const boxOrderedXGovs = this.convertStoredXGovsToXGovs(storedXGovs, accountIdMap)
    const xGovs = [...boxOrderedXGovs].sort(this.sortXGovs)

    const params = await this.algorand.getSuggestedParams();
    const networkGenesisHash = Buffer.from(params.genesisHash!).toString("base64");
    // TODO validate committee ID

    return {
      networkGenesisHash,
      periodEnd: committeeMetadata.periodEnd,
      periodStart: committeeMetadata.periodStart,
      registryId: Number(committeeMetadata.xGovRegistryId),
      totalMembers: committeeMetadata.totalMembers,
      totalVotes: committeeMetadata.totalVotes,
      xGovs: xGovs.map(({ account, votes }) => ({ address: account.toString(), votes })).sort((a, b) => (a.address < b.address ? -1 : 1)),
      ...(includeBoxOrder ? { xGovBoxOrder: boxOrderedXGovs.map(({ account }) => account.toString()) } : {}),
    };
  }

  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: 0,
  ): Promise<{ committeeMetadata: CommitteeMetadata; storedXGovs: StoredXGov[]; lastDataPage: number; totalDataPages: number }>;
  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: number,
  ): Promise<{ storedXGovs: StoredXGov[]; lastDataPage: number }>;
  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: number,
  ): Promise<{ committeeMetadata?: CommitteeMetadata; storedXGovs: StoredXGov[]; lastDataPage: number; totalDataPages?: number }> {
    const returnMetadata = startDataPage === 0;
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup();

    for (let i = 0; i < PARTIAL_COMMITTEE_SIMULATE_CALLS; i++) {
      const logMetadata = returnMetadata && i === 0;
      const dataPageLength = logMetadata ? PARTIAL_COMMITTEE_FIRST_DATA_PAGE_LENGTH : PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH;
      builder = builder.logCommitteePages({
        args: { committeeId: committeeIdToRaw(committeeId), logMetadata: returnMetadata && i === 0, startDataPage, dataPageLength },
      });
      startDataPage += dataPageLength;
    }

    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    let committeeMetadata: CommitteeMetadata | undefined;
    let superboxMeta: SuperboxMeta | undefined;
    let storedXGovs: StoredXGov[] = [];

    let ptr = 0;
    if (returnMetadata) {
      committeeMetadata = getABIDecodedValue(
        new Uint8Array(logs[ptr++]!),
        "CommitteeMetadata",
        this.readClient.appSpec.structs,
      ) as CommitteeMetadata;
      superboxMeta = getABIDecodedValue(new Uint8Array(logs[ptr++]!), "SuperboxMeta", this.readClient.appSpec.structs) as SuperboxMeta;
    }
    for (let i = ptr; i < logs.length; i++) {
      const logValue = new Uint8Array(logs[i]!);
      if (logValue.length > 0) {
        const pageXGovs = this.convertSuperboxToStoredXGovs(logValue);
        storedXGovs = storedXGovs.concat(pageXGovs);
      } else {
        break; // reached end of data pages
      }
    }
    return {
      committeeMetadata,
      storedXGovs,
      lastDataPage: startDataPage - 1,
      totalDataPages: superboxMeta ? superboxMeta.boxByteLengths.length : undefined,
    };
  }

  async getCommitteeXGovs(committeeId: CommitteeId): Promise<AccountWithVotes[]> {
    const [storedXGovs, accountMap] = await Promise.all([this.getCommitteeSuperboxData(committeeId), this.getAccountIdMap()]);
    return this.convertStoredXGovsToXGovs(storedXGovs, accountMap).sort(this.sortXGovs)
  }

  protected convertStoredXGovsToXGovs(storedXGovs: StoredXGov[], accountMap: Map<string, number>): AccountWithVotes[] {
    return storedXGovs
      .map(([id, votes]) => {
        const accountRaw = Array.from(accountMap.entries()).find(([, accountId]) => accountId === id);
        const account = accountRaw ? accountRaw[0] : ALGORAND_ZERO_ADDRESS_STRING;
        return {
          accountId: id,
          account,
          votes,
        };
      })
  }

  protected sortXGovs(a: AccountWithVotes, b: AccountWithVotes): number {
    return a.account < b.account ? -1 : 1;
  }

  async getAdmin(): Promise<string> {
    const admin = await this.readClient.state.global.admin();
    return admin!;
  }

  async getCommitteeMetadata(committeeId: CommitteeId, mustBeComplete: boolean = false): Promise<CommitteeMetadata | null> {
    const { return: committeeMetadata } = await this.readClient.send.getCommitteeMetadata({
      args: { committeeId: committeeIdToRaw(committeeId), mustBeComplete },
    });
    if (committeeMetadata!.periodEnd === 0) return null;
    return committeeMetadata!;
  }

  /**
   * Batch-fetch metadata for many committees in a single (chunked) simulate group via `logCommitteeMetadata`.
   * The result is index-aligned with `committeeIds`; non-existent committees (periodEnd === 0) come back as null.
   */
  async getCommitteesMetadata(committeeIds: CommitteeId[]): Promise<(CommitteeMetadata | null)[]> {
    return this._getCommitteesMetadataChunked(committeeIds.map((id) => committeeIdToRaw(id)));
  }

  @chunked(128)
  private async _getCommitteesMetadataChunked(committeeIds: Uint8Array[]): Promise<(CommitteeMetadata | null)[]> {
    if (committeeIds.length === 0) return [];
    const committeeIdChunks = chunk(committeeIds, 63);
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup();
    for (const committeeIdChunk of committeeIdChunks) {
      builder = builder.logCommitteeMetadata({ args: { committeeIds: committeeIdChunk } });
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) => {
      const meta = getABIDecodedValue(new Uint8Array(log!), "CommitteeMetadata", this.readClient.appSpec.structs) as CommitteeMetadata;
      return meta.periodEnd === 0 ? null : meta;
    });
  }

  /**
   * Batch-read an account's xGov voting power across many committees in a single (chunked) simulate group.
   * The result is index-aligned with `committeeIds`. There is no batch ABI method, so each committee is one
   * readonly call grouped into the simulate (chunked to stay under the 16-txn group limit).
   *
   * Uses the non-throwing `tryGetXGovVotingPower` (returns 0 for committees the account is not a member of) —
   * the throwing `getXGovVotingPower` would fail the entire simulate group on the first non-member committee.
   */
  async getXGovVotingPowers(committeeIds: CommitteeId[], account: string): Promise<number[]> {
    return this._getXGovVotingPowersChunked(committeeIds.map((id) => committeeIdToRaw(id)), account);
  }

  @chunked(16)
  private async _getXGovVotingPowersChunked(committeeIds: Uint8Array[], account: string): Promise<number[]> {
    if (committeeIds.length === 0) return [];
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup();
    for (const committeeId of committeeIds) {
      builder = builder.tryGetXGovVotingPower({ args: { committeeId, account } });
    }
    const { returns } = await builder.simulate(SIMULATE_PARAMS);
    return (returns ?? []).map((power: unknown) => Number(power ?? 0));
  }

  async getCommitteeSuperboxMeta(committeeId: CommitteeId): Promise<SuperboxMeta> {
    const { return: superboxMeta } = await this.readClient.send.getCommitteeSuperboxMeta({
      args: { committeeId: committeeIdToRaw(committeeId) },
    });
    return superboxMeta!;
  }

  async getCommitteeSuperboxData(committeeId: CommitteeId): Promise<StoredXGov[]> {
    const [meta, commmitteeMetadata] = await Promise.all([
      this.getCommitteeSuperboxMeta(committeeId),
      this.getCommitteeMetadata(committeeId),
    ]);
    const numPages = Math.ceil(Number(meta.totalByteLength) / Number(meta.maxBoxSize));
    const pages = Array.from({ length: numPages }, (_, i) => i);
    const pageData = await pMap(pages, (page) => this.getSuperboxAsStoredXGovs(this.getCommitteeSuperboxPageKey(commmitteeMetadata!, page)), {
      concurrency: this.concurrency,
    });
    return pageData.flat();
  }

  getCommitteeSuperboxPrefix(committeeMetadata: CommitteeMetadata): string {
    return `S${committeeMetadata.numericId}`;
  }

  getCommitteeSuperboxPageKey(committeeMetadata: CommitteeMetadata, page: number): string {
    // superbox@2.0.0 delimits the prefix from the page index with `_` (data box name = `name + '_' + page`)
    return `${this.getCommitteeSuperboxPrefix(committeeMetadata)}_${page}`;
  }

  async getCommitteeSuperboxDataLast(committeeId: CommitteeId): Promise<{ last?: StoredXGov; total: number }> {
    const [meta, commmitteeMetadata] = await Promise.all([
      this.getCommitteeSuperboxMeta(committeeId),
      this.getCommitteeMetadata(committeeId),
    ]);
    const numXGovs = Math.ceil(Number(meta.totalByteLength) / Number(meta.valueSize));
    if (numXGovs === 0) {
      return { total: 0 };
    }
    const numPages = Math.ceil(Number(meta.totalByteLength) / Number(meta.maxBoxSize));
    const superboxKey =  this.getCommitteeSuperboxPageKey(commmitteeMetadata!, numPages - 1);
    const lastPage = await this.getSuperboxAsStoredXGovs(superboxKey);
    return { last: lastPage[lastPage.length - 1], total: numXGovs };
  }

  protected async getSuperboxAsStoredXGovs(superboxKey: string): Promise<StoredXGov[]> {
    return this.convertSuperboxToStoredXGovs(await this.algorand.app.getBoxValue(this.appId, superboxKey));
  }

  protected convertSuperboxToStoredXGovs(arr: Uint8Array): StoredXGov[] {
    const chunks = chunk(Array.from(arr), STORED_XGOV_BYTE_LENGTH); // each StoredXGov is (uint32, uint32)
    return chunks.map((c) => getABIDecodedValue(new Uint8Array(c), "(uint32,uint32)", {}) as StoredXGov);
  }

  async getAccounts(): Promise<string[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId);
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 97 && nameRaw.length === 33)
      .map(({ nameRaw }) => {
        return encodeAddress(nameRaw.slice(1)).toString();
      });
  }

  async getAccountIdMap(accounts?: string[]): Promise<Map<string, number>> {
    accounts = accounts ?? (await this.getAccounts());
    const gGovAccounts = await this._getGGovAccountsChunked(accounts);
    return new Map(accounts.map((account, index) => [account, gGovAccounts[index].accountId]));
  }

  async getGGovAccountsMap(accounts?: string[]): Promise<Map<string, GGovAccount>> {
    accounts = accounts ?? (await this.getAccounts());
    const gGovAccounts = await this._getGGovAccountsChunked(accounts);
    return new Map(accounts.map((account, index) => [account, gGovAccounts[index]]));
  }

  @chunked(128)
  private async _getGGovAccountsChunked(accounts: string[]): Promise<GGovAccount[]> {
    if (accounts.length === 0) return [];
    const accountArgs = chunk(accounts, 63);
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup();
    for (const accountChunk of accountArgs) {
      builder = builder.logAccounts({ args: { accounts: accountChunk } });
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "GGovAccount", this.readClient.appSpec.structs) as GGovAccount,
    );
  }
}
