import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { ABIType, encodeAddress, makeEmptyTransactionSigner } from 'algosdk'
import pMap from 'p-map'
import { GGovRegistryReaderSDK, SIMULATE_PARAMS } from '../registry'
import { GGovRegistryClient, GGovPeriodSummary } from '../generated/GGovRegistryClient'
import {
  GGovPeriodClient,
  GGovPeriodComposer,
  GGovPeriod,
  GGovPeriodShort,
  GGovVoteRecord,
  APP_SPEC as PERIOD_APP_SPEC,
} from '../generated/GGovPeriodClient'
import { getConstructorConfig } from '../networkConfig'
import { BodyJson, PeriodBodyJson, parseBodyJson, ReaderConstructorArgs } from './types'
import { assertUint } from '../util/assertUint'
import { chunked } from '../util/chunked'
import { errorTransformer, wrapErrors } from '../util/wrapErrors'

const EMPTY_PERIOD: GGovPeriod = {
  committeeId: new Uint8Array(32),
  votingStart: 0,
  votingEnd: 0,
  topics: [],
}

/** Per-address voting eligibility + power, as returned by `canVote`/`canVoteMany`. */
export interface CanVoteResult {
  canVote: boolean
  votingPower: bigint
}

/** Max `canVote` app calls packed into a single simulate group (Algorand 16-txn group limit). */
const CAN_VOTE_GROUP_SIZE = 16

export interface PeriodWithSummary {
  id: bigint
  period: GGovPeriod
  summary: GGovPeriodSummary
}

export class GGovReaderSDK {
  static PERIOD_APP_SPEC = PERIOD_APP_SPEC

  public algorand: AlgorandClient
  /** Composed registry reader SDK (committee registry + operator + delegations + periods). */
  public registry: GGovRegistryReaderSDK
  /** Registry app ID. */
  public registryAppId: bigint
  public concurrency: number
  public debug?: boolean
  protected readerAccount?: string
  /** periodId → period contract appId */
  protected periodAppCache: Map<bigint, bigint> = new Map()
  /** periodId → cached read-only client */
  protected periodReadClientCache: Map<bigint, GGovPeriodClient> = new Map()

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest)
    this.algorand = algorand
    algorand.setSuggestedParamsCacheTimeout(6000)
    algorand.registerErrorTransformer(errorTransformer)
    this.registryAppId = appId
    this.concurrency = concurrency
    this.debug = debug
    this.readerAccount = readerAccount
    this.registry = new GGovRegistryReaderSDK({
      algorand,
      concurrency,
      debug,
      registryAppId: appId,
      readerAccount,
    })
  }

  /** Convenience accessor — same as `registry.appId`. */
  get appId(): bigint {
    return this.registryAppId
  }

  /** Registry read client. */
  get registryReadClient(): GGovRegistryClient {
    return this.registry.readClient as unknown as GGovRegistryClient
  }

  // ── Registry passthroughs (end-user delegation reads) ────────────
  // A voter self-services their own delegation, so these are forwarded for ergonomics (no `.registry`).
  // Admin/analytics/committee reads (getAllDelegations, getCommitteeIds, getCommittee*, …) stay on `.registry`.

  /** "Who am I delegating my voting power to?" */
  getDelegation = (...args: Parameters<GGovRegistryReaderSDK['getDelegation']>) => this.registry.getDelegation(...args)
  /** "Who has delegated their voting power to me?" */
  getDelegators = (...args: Parameters<GGovRegistryReaderSDK['getDelegators']>) => this.registry.getDelegators(...args)

  // ── Period app resolution ────────────────────────────────────────

  /** Resolve the on-chain app ID for a periodId. Throws if the period is unknown. */
  @wrapErrors()
  async getPeriodAppId(periodId: bigint | number): Promise<bigint> {
    const pid = assertUint(periodId, 64, 'periodId')
    const cached = this.periodAppCache.get(pid)
    if (cached !== undefined) return cached
    const { return: appId } = await this.registryReadClient.send.getPeriodApp({ args: { periodId: pid } })
    const idBig = BigInt(appId ?? 0)
    if (idBig === 0n) throw new Error(`Period ${pid} not found in registry`)
    this.periodAppCache.set(pid, idBig)
    return idBig
  }

  /** Build (and cache) a read-only per-period client. */
  protected async getPeriodReadClient(periodId: bigint | number): Promise<GGovPeriodClient> {
    const pid = assertUint(periodId, 64, 'periodId')
    const cached = this.periodReadClientCache.get(pid)
    if (cached) return cached
    const appId = await this.getPeriodAppId(pid)
    const client = new GGovPeriodClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    })
    this.periodReadClientCache.set(pid, client)
    return client
  }

  // ── Per-period reads ─────────────────────────────────────────────

  // TODO These are not exported in ARC56 because they are not used in an ABI return type
  // if we want to keep them in sync automatically we can create a separate dummy contract
  // with dummy methods with these return types for client-generation, and import the dummy client app spec.

  // ARC-4 layouts logged by GGovPeriod.logPeriod(): the header line then one topic per line.
  private static readonly PERIOD_META_TYPE = ABIType.from('(byte[32],uint32,uint32,uint32)')
  private static readonly PERIOD_TOPIC_TYPE = ABIType.from('(string[],uint32[])')

  // ARC-4 layouts logged by GGovPeriod.logVotingRecord(): the header line then one topic's votes per line.
  private static readonly VOTE_RECORD_META_TYPE = ABIType.from('(bool,uint32)')
  private static readonly VOTE_RECORD_TOPIC_TYPE = ABIType.from('(uint32[])')

  /**
   * Read a full period. Uses the contract's `logPeriod` (one log line for the header, one
   * per topic) rather than `getPeriod`, whose single ARC-4 return value overflows the
   * 1024-byte per-call log limit past ~21 topics. Simulated with allowMoreLogging so the
   * logs are uncapped; the reconstructed shape is identical to the old getPeriod return.
   */
  @wrapErrors()
  async getPeriod(periodId: bigint | number): Promise<GGovPeriod> {
    // Validate outside the try so a bad id throws clearly instead of being swallowed as EMPTY_PERIOD.
    assertUint(periodId, 64, 'periodId')
    try {
      const client = await this.getPeriodReadClient(periodId)
      const { confirmations } = await client.newGroup().logPeriod({ args: {} }).simulate(SIMULATE_PARAMS)
      const logs = confirmations.flatMap((c: any) => (c.logs ?? []) as Uint8Array[])
      if (logs.length === 0) return EMPTY_PERIOD

      const [committeeId, votingStart, votingEnd] = GGovReaderSDK.PERIOD_META_TYPE.decode(new Uint8Array(logs[0])) as [
        Uint8Array,
        bigint,
        bigint,
        bigint,
      ]
      const topics = logs.slice(1).map((log) => {
        const [options, votes] = GGovReaderSDK.PERIOD_TOPIC_TYPE.decode(new Uint8Array(log)) as [string[], bigint[]]
        return [options, votes.map((v) => Number(v))] as [string[], number[]]
      })

      return { committeeId, votingStart: Number(votingStart), votingEnd: Number(votingEnd), topics }
    } catch {
      return EMPTY_PERIOD
    }
  }

  /**
   * Read the short period shape (committee, voting window, and per-topic option counts) that the
   * fractional delegator consumes. Unlike `getPeriod`, this never carries the topic options/votes,
   * so its single ARC-4 return value stays small — no log-line reconstruction needed. Simulated via
   * the readonly `getPeriodShort` ABI method.
   */
  @wrapErrors()
  async getPeriodShort(periodId: bigint | number): Promise<GGovPeriodShort> {
    const client = await this.getPeriodReadClient(periodId)
    const { return: short } = await client.send.getPeriodShort({ args: {} })
    return short!
  }

  /**
   * Read a vote record. Uses the contract's `logVotingRecord` (one log line for the header, one
   * per topic) rather than `getVotingRecord`, whose single ARC-4 return value overflows the
   * 1024-byte per-call log limit once topicVotes grows large (same failure mode as getPeriod).
   * No logs means no record exists; an empty topicVotes is likewise treated as no record.
   */
  @wrapErrors()
  async getVotingRecord(periodId: bigint | number, account: string): Promise<GGovVoteRecord | null> {
    const client = await this.getPeriodReadClient(periodId)
    const { confirmations } = await client.newGroup().logVotingRecord({ args: { account } }).simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap((c: any) => (c.logs ?? []) as Uint8Array[])
    if (logs.length === 0) return null

    const [isDelegated] = GGovReaderSDK.VOTE_RECORD_META_TYPE.decode(new Uint8Array(logs[0])) as [boolean, bigint]
    const topicVotes = logs.slice(1).map((log) => {
      const [votes] = GGovReaderSDK.VOTE_RECORD_TOPIC_TYPE.decode(new Uint8Array(log)) as [bigint[]]
      return votes.map((v) => Number(v))
    })
    if (topicVotes.length === 0) return null
    return { isDelegated, topicVotes }
  }

  @wrapErrors()
  async canVote(periodId: bigint | number, voterAccount: string, senderAccount?: string): Promise<CanVoteResult> {
    const client = await this.getPeriodReadClient(periodId)
    const { return: result } = await client.send.canVote({
      args: { voterAccount, senderAccount: senderAccount ?? voterAccount },
      // canVote does inner calls to registry — pay extra fee for 2 inner calls
      extraFee: (2000).microAlgo(),
    })
    return { canVote: result![0], votingPower: result![1] }
  }

  /**
   * Voting eligibility + power for many accounts in one period, keyed by voter address. Packs
   * up to 16 `canVote` app calls (one per address) into each simulate group, then simulates the
   * groups in parallel with `pMap` bounded by `this.concurrency`.
   *
   * `senderAccount` is the wallet that would submit the vote (self, or the delegate). Pass a
   * single address to use it for every account, or a map of account → sender to check each
   * voter against its own sender; omit to default each voter's sender to itself.
   */
  async canVoteMany(
    periodId: bigint | number,
    voterAccounts: string[],
    senderAccount?: string | Record<string, string | undefined>,
  ): Promise<Map<string, CanVoteResult>> {
    const senderFor = (voter: string): string =>
      senderAccount == null
        ? voter
        : typeof senderAccount === 'string'
          ? senderAccount
          : (senderAccount[voter] ?? voter)
    const pairs = voterAccounts.map((voterAccount) => ({ voterAccount, senderAccount: senderFor(voterAccount) }))
    const results = await this._canVoteManyChunked(periodId, pairs)
    return new Map(voterAccounts.map((voterAccount, i) => [voterAccount, results[i]]))
  }

  /**
   * One simulate group of up to 16 `canVote` calls. `@chunked` splits larger inputs into
   * 16-call groups and runs them through `pMap` at `this.concurrency`, flattening the results
   * back in order.
   */
  @chunked(CAN_VOTE_GROUP_SIZE, 1)
  @wrapErrors()
  protected async _canVoteManyChunked(
    periodId: bigint | number,
    pairs: { voterAccount: string; senderAccount: string }[],
  ): Promise<CanVoteResult[]> {
    if (pairs.length === 0) return []
    const client = await this.getPeriodReadClient(periodId)
    let builder: GGovPeriodComposer<any> = client.newGroup()
    for (const { voterAccount, senderAccount } of pairs) {
      builder = builder.canVote({
        args: { voterAccount, senderAccount },
        // each canVote does 2 inner calls to the registry — cover their fees via pooling
        extraFee: (2000).microAlgo(),
      })
    }
    const { returns } = await builder.simulate(SIMULATE_PARAMS)
    return (returns ?? []).map((result: any) => ({ canVote: result![0], votingPower: result![1] }))
  }

  /** Read the body JSON for a period from its per-period app. */
  async getPeriodBody(periodId: bigint | number): Promise<PeriodBodyJson | null> {
    // Validate outside the try so a bad id throws clearly instead of being swallowed as null.
    assertUint(periodId, 64, 'periodId')
    try {
      const appId = await this.getPeriodAppId(periodId)
      const key = new Uint8Array(1)
      key[0] = 0x50 // 'P'
      const raw = await this.algorand.app.getBoxValue(appId, key)
      return parseBodyJson(raw)
    } catch {
      return null
    }
  }

  /** Read the body JSON for a topic from its per-period app. */
  async getTopicBody(periodId: bigint | number, topicIndex: bigint | number): Promise<BodyJson | null> {
    // Validate outside the try so a bad id/index throws clearly instead of being swallowed as null.
    // `setUint32` would otherwise silently wrap/truncate an out-of-range or non-integer topicIndex.
    assertUint(periodId, 64, 'periodId')
    const topicIndexArg = Number(assertUint(topicIndex, 32, 'topicIndex'))
    try {
      const appId = await this.getPeriodAppId(periodId)
      const key = new Uint8Array(5)
      key[0] = 0x54 // 'T'
      const view = new DataView(key.buffer)
      view.setUint32(1, topicIndexArg)
      const raw = await this.algorand.app.getBoxValue(appId, key)
      return parseBodyJson(raw)
    } catch {
      return null
    }
  }

  /**
   * Addresses that cast a vote in a period. Scans the per-period app's box names for
   * the `voteRecords` map (`BoxMap<Account, GGovVoteRecord>({ keyPrefix: 'v' })`) — one
   * box per voter — so its length is the number of distinct voted governors. Mirrors the
   * registry reader's `getAccounts`/`getAllDelegations` box-name scans.
   */
  @wrapErrors()
  async getVoters(periodId: bigint | number): Promise<string[]> {
    const appId = await this.getPeriodAppId(periodId)
    const boxNames = await this.algorand.app.getBoxNames(appId)
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 0x76 && nameRaw.length === 33) // 'v' prefix + 32-byte address
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(1)).toString())
  }

  // ── Spanning reads (registry summaries + per-period apps) ────────

  /** Fetch full periods. Routes through registry summaries → per-period fetches. */
  @wrapErrors()
  async getPeriods(periodIds: bigint[]): Promise<GGovPeriod[]> {
    // TODO can be made more efficient by logPeriods() on registry
    const summaries = await this.registry.getPeriodSummaries(periodIds)
    return pMap(
      periodIds,
      async (pid, i) => {
        const summary = summaries[i]
        if (!summary || BigInt(summary.appId) === 0n) return EMPTY_PERIOD
        // populate cache so getPeriod doesn't re-query the registry
        this.periodAppCache.set(BigInt(pid), BigInt(summary.appId))
        return this.getPeriod(pid)
      },
      { concurrency: this.concurrency },
    )
  }

  /**
   * All live periods with full data + registry summary. Built on the registry's
   * getAllPeriodSummaries, so deleted periods (summary.appId === 0) are already filtered out.
   */
  @wrapErrors()
  async getAllPeriods(): Promise<PeriodWithSummary[]> {
    const summaries = await this.registry.getAllPeriodSummaries()
    return pMap(
      summaries,
      async ({ id, summary }) => {
        // populate cache so getPeriod doesn't re-query the registry for the appId
        this.periodAppCache.set(id, BigInt(summary.appId))
        return { id, period: await this.getPeriod(id), summary }
      },
      { concurrency: this.concurrency },
    )
  }

  /** Read all global state of a period app, plus the current network round. */
  async getPeriodGlobalState(periodId: bigint | number) {
    const client = await this.getPeriodReadClient(periodId)
    // TODO not atomic, could simulate a logGlobalState to get the current round atomically
    const [state, status] = await Promise.all([client.state.global.getAll(), this.algorand.client.algod.status().do()])
    return { ...state, currentRound: status.lastRound }
  }
}
