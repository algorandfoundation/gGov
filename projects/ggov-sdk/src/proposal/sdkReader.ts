import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getABIDecodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { ABIType, encodeAddress, makeEmptyTransactionSigner } from "algosdk";
import pMap from "p-map";
import { GGovRegistryReaderSDK, SIMULATE_PARAMS } from "../registry";
import { GGovRegistryClient, GGovPeriodSummary } from "../generated/GGovRegistryClient";
import { GGovPeriodClient, GGovPeriod, GGovVoteRecord } from "../generated/GGovPeriodClient";
import { getConstructorConfig } from "../networkConfig";
import { BodyJson, parseBodyJson, ReaderConstructorArgs } from "./types";
import { chunked } from "../util/chunked";
import { errorTransformer, wrapErrors } from "../util/wrapErrors";

const EMPTY_PERIOD: GGovPeriod = {
  committeeId: new Uint8Array(32),
  votingStart: 0,
  votingEnd: 0,
  topics: [],
};

export interface PeriodSummaryWithId {
  id: bigint;
  summary: GGovPeriodSummary;
}

export interface PeriodWithSummary {
  id: bigint;
  period: GGovPeriod;
  summary: GGovPeriodSummary;
}

export class GGovReaderSDK {
  public algorand: AlgorandClient;
  /** Composed registry reader SDK (committee registry + operator + delegations + periods). */
  public registry: GGovRegistryReaderSDK;
  /** Registry app ID. */
  public registryAppId: bigint;
  public concurrency: number;
  public debug?: boolean;
  protected readerAccount?: string;
  /** periodId → period contract appId */
  protected periodAppCache: Map<bigint, bigint> = new Map();
  /** periodId → cached read-only client */
  protected periodReadClientCache: Map<bigint, GGovPeriodClient> = new Map();

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest);
    this.algorand = algorand;
    algorand.setSuggestedParamsCacheTimeout(6000);
    algorand.registerErrorTransformer(errorTransformer);
    this.registryAppId = appId;
    this.concurrency = concurrency;
    this.debug = debug;
    this.readerAccount = readerAccount;
    this.registry = new GGovRegistryReaderSDK({
      algorand,
      concurrency,
      debug,
      registryAppId: appId,
      readerAccount,
    });
  }

  /** Convenience accessor — same as `registry.appId`. */
  get appId(): bigint {
    return this.registryAppId;
  }

  /** Registry read client. */
  get registryReadClient(): GGovRegistryClient {
    return this.registry.readClient as unknown as GGovRegistryClient;
  }

  // ── Period app resolution ────────────────────────────────────────

  /** Resolve the on-chain app ID for a periodId. Throws if the period is unknown. */
  @wrapErrors()
  async getPeriodAppId(periodId: bigint | number): Promise<bigint> {
    const pid = BigInt(periodId);
    const cached = this.periodAppCache.get(pid);
    if (cached !== undefined) return cached;
    const { return: appId } = await this.registryReadClient.send.getPeriodApp({ args: { periodId: pid } });
    const idBig = BigInt(appId ?? 0);
    if (idBig === 0n) throw new Error(`Period ${pid} not found in registry`);
    this.periodAppCache.set(pid, idBig);
    return idBig;
  }

  /** Build (and cache) a read-only per-period client. */
  protected async getPeriodReadClient(periodId: bigint | number): Promise<GGovPeriodClient> {
    const pid = BigInt(periodId);
    const cached = this.periodReadClientCache.get(pid);
    if (cached) return cached;
    const appId = await this.getPeriodAppId(pid);
    const client = new GGovPeriodClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    });
    this.periodReadClientCache.set(pid, client);
    return client;
  }

  // ── Per-period reads ─────────────────────────────────────────────

  // TODO These are not exported in ARC56 because they are not used in an ABI return type
  // if we want to keep them in sync automatically we can create a separate dummy contract
  // with dummy methods with these return types for client-generation, and import the dummy client app spec.

  // ARC-4 layouts logged by GGovPeriod.logPeriod(): the header line then one topic per line.
  private static readonly PERIOD_META_TYPE = ABIType.from("(byte[32],uint32,uint32,uint32)");
  private static readonly PERIOD_TOPIC_TYPE = ABIType.from("(string[],uint32[])");

  // ARC-4 layouts logged by GGovPeriod.logVotingRecord(): the header line then one topic's votes per line.
  private static readonly VOTE_RECORD_META_TYPE = ABIType.from("(bool,uint32)");
  private static readonly VOTE_RECORD_TOPIC_TYPE = ABIType.from("(uint32[])");

  /**
   * Read a full period. Uses the contract's `logPeriod` (one log line for the header, one
   * per topic) rather than `getPeriod`, whose single ARC-4 return value overflows the
   * 1024-byte per-call log limit past ~21 topics. Simulated with allowMoreLogging so the
   * logs are uncapped; the reconstructed shape is identical to the old getPeriod return.
   */
  @wrapErrors()
  async getPeriod(periodId: bigint | number): Promise<GGovPeriod> {
    try {
      const client = await this.getPeriodReadClient(periodId);
      const { confirmations } = await client.newGroup().logPeriod({ args: {} }).simulate(SIMULATE_PARAMS);
      const logs = confirmations.flatMap((c: any) => (c.logs ?? []) as Uint8Array[]);
      if (logs.length === 0) return EMPTY_PERIOD;

      const [committeeId, votingStart, votingEnd] = GGovReaderSDK.PERIOD_META_TYPE.decode(
        new Uint8Array(logs[0]),
      ) as [Uint8Array, bigint, bigint, bigint];
      const topics = logs.slice(1).map((log) => {
        const [options, votes] = GGovReaderSDK.PERIOD_TOPIC_TYPE.decode(new Uint8Array(log)) as [string[], bigint[]];
        return [options, votes.map((v) => Number(v))] as [string[], number[]];
      });

      return { committeeId, votingStart: Number(votingStart), votingEnd: Number(votingEnd), topics };
    } catch {
      return EMPTY_PERIOD;
    }
  }

  /**
   * Read a vote record. Uses the contract's `logVotingRecord` (one log line for the header, one
   * per topic) rather than `getVotingRecord`, whose single ARC-4 return value overflows the
   * 1024-byte per-call log limit once topicVotes grows large (same failure mode as getPeriod).
   * No logs means no record exists; an empty topicVotes is likewise treated as no record.
   */
  @wrapErrors()
  async getVotingRecord(periodId: bigint | number, account: string): Promise<GGovVoteRecord | null> {
    const client = await this.getPeriodReadClient(periodId);
    const { confirmations } = await client.newGroup().logVotingRecord({ args: { account } }).simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap((c: any) => (c.logs ?? []) as Uint8Array[]);
    if (logs.length === 0) return null;

    const [byDelegator] = GGovReaderSDK.VOTE_RECORD_META_TYPE.decode(new Uint8Array(logs[0])) as [boolean, bigint];
    const topicVotes = logs.slice(1).map((log) => {
      const [votes] = GGovReaderSDK.VOTE_RECORD_TOPIC_TYPE.decode(new Uint8Array(log)) as [bigint[]];
      return votes.map((v) => Number(v));
    });
    if (topicVotes.length === 0) return null;
    return { byDelegator, topicVotes };
  }

  @wrapErrors()
  async canVote(
    periodId: bigint | number,
    voterAccount: string,
    senderAccount?: string,
  ): Promise<{ canVote: boolean; votingPower: bigint }> {
    const client = await this.getPeriodReadClient(periodId);
    const { return: result } = await client.send.canVote({
      args: { voterAccount, senderAccount: senderAccount ?? voterAccount },
      // canVote does inner calls to registry — pay extra fee for 2 inner calls
      extraFee: (2000).microAlgo(),
    });
    return { canVote: result![0], votingPower: result![1] };
  }

  /** Read the body JSON for a period from its per-period app. */
  async getPeriodBody(periodId: bigint | number): Promise<BodyJson | null> {
    try {
      const appId = await this.getPeriodAppId(periodId);
      const key = new Uint8Array(1);
      key[0] = 0x50; // 'P'
      const raw = await this.algorand.app.getBoxValue(appId, key);
      return parseBodyJson(raw);
    } catch {
      return null;
    }
  }

  /** Read the body JSON for a topic from its per-period app. */
  async getTopicBody(periodId: bigint | number, topicIndex: bigint | number): Promise<BodyJson | null> {
    try {
      const appId = await this.getPeriodAppId(periodId);
      const key = new Uint8Array(5);
      key[0] = 0x54; // 'T'
      const view = new DataView(key.buffer);
      view.setUint32(1, Number(topicIndex));
      const raw = await this.algorand.app.getBoxValue(appId, key);
      return parseBodyJson(raw);
    } catch {
      return null;
    }
  }

  // ── Registry reads ──────────────────────────────────────────────

  /** Fetch per-period summaries (appId, votingStart, votingEnd, numTopics) in one round trip. */
  @chunked(128)
  @wrapErrors()
  async getPeriodSummaries(periodIds: bigint[]): Promise<GGovPeriodSummary[]> {
    const builder = this.registryReadClient.newGroup().logPeriodSummaries({ args: { periodIds } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(
        new Uint8Array(log!),
        "GGovPeriodSummary",
        this.registryReadClient.appSpec.structs,
      ) as GGovPeriodSummary,
    );
  }

  /** Fetch full periods. Routes through summaries → per-period fetches. Preserves prior signature. */
  @wrapErrors()
  async getPeriods(periodIds: bigint[]): Promise<GGovPeriod[]> {
    // TODO can be made more efficient by logPeriods() on registry
    const summaries = await this.getPeriodSummaries(periodIds);
    return pMap(
      periodIds,
      async (pid, i) => {
        const summary = summaries[i];
        if (!summary || BigInt(summary.appId) === 0n) return EMPTY_PERIOD;
        // populate cache so getPeriod doesn't re-query the registry
        this.periodAppCache.set(BigInt(pid), BigInt(summary.appId));
        return this.getPeriod(pid);
      },
      { concurrency: this.concurrency },
    );
  }

  /**
   * All live period summaries on the registry, paired with their periodId.
   * Enumerates 1..lastPeriodId and filters out deleted periods (summary.appId === 0).
   */
  @wrapErrors()
  async getAllPeriodSummaries(): Promise<PeriodSummaryWithId[]> {
    const { lastPeriodId } = await this.getGlobalState();
    const count = Number(lastPeriodId ?? 0);
    if (count === 0) return [];
    const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
    const summaries = await this.getPeriodSummaries(ids);
    return ids
      .map((id, i) => ({ id, summary: summaries[i] }))
      .filter(({ summary }) => summary && BigInt(summary.appId) !== 0n);
  }

  /**
   * All live periods with full data + registry summary. Built on getAllPeriodSummaries,
   * so deleted periods (summary.appId === 0) are already filtered out.
   */
  @wrapErrors()
  async getAllPeriods(): Promise<PeriodWithSummary[]> {
    const summaries = await this.getAllPeriodSummaries();
    return pMap(
      summaries,
      async ({ id, summary }) => {
        // populate cache so getPeriod doesn't re-query the registry for the appId
        this.periodAppCache.set(id, BigInt(summary.appId));
        return { id, period: await this.getPeriod(id), summary };
      },
      { concurrency: this.concurrency },
    );
  }

  @wrapErrors()
  async getDelegation(account: string): Promise<{ delegatee: string; exists: boolean }> {
    const { return: result } = await this.registryReadClient.send.getDelegation({ args: { account } });
    return { delegatee: result![0], exists: result![1] };
  }

  /** Reverse lookup: addresses that have delegated to $delegatee (empty if none), one per log line. */
  @wrapErrors()
  async getDelegators(delegatee: string): Promise<string[]> {
    const builder = this.registryReadClient.newGroup().logDelegators({ args: { delegatee } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    // A confirmation with no logs surfaces as an undefined `logs` field — coalesce so the empty
    // reverse list (box deleted) yields [] rather than a single undefined entry.
    const logs = confirmations.flatMap(({ logs }) => logs ?? []);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "address", this.registryReadClient.appSpec.structs) as string,
    );
  }

  @chunked(128)
  @wrapErrors()
  async getDelegations(accounts: string[]): Promise<string[]> {
    const builder = this.registryReadClient.newGroup().logDelegations({ args: { accounts } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "address", this.registryReadClient.appSpec.structs) as string,
    );
  }

  /** Get all delegations by scanning delegation box keys and batch-fetching delegatees. */
  async getAllDelegations(): Promise<Map<string, string>> {
    const boxNames = await this.algorand.app.getBoxNames(this.registryAppId);
    const accounts = boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 0x64 && nameRaw.length === 33) // 'd' prefix + 32-byte address
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(1)).toString());
    if (accounts.length === 0) return new Map();
    const delegatees = await this.getDelegations(accounts);
    return new Map(accounts.map((account, i) => [account, delegatees[i]]));
  }

  /** List committee IDs registered on the registry (box-name scan). */
  async getCommitteeIds(): Promise<Uint8Array[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.registryAppId);
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 99 && nameRaw.length === 33) // 'c' prefix
      .map(({ nameRaw }) => nameRaw.slice(1));
  }

  /** Read all registry global state. */
  getGlobalState() {
    return this.registryReadClient.state.global.getAll();
  }
}
