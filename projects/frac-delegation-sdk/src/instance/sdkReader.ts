import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { makeEmptyTransactionSigner } from 'algosdk'
import { FracDelegationRegistryReaderSDK, SIMULATE_PARAMS } from '../registry'
import { FracDelegationRegistryClient } from '../generated/FracDelegationRegistryClient'
import {
  FracDelegationInstanceClient,
  FracDelegationInstanceComposer,
  APP_SPEC as INSTANCE_APP_SPEC,
  FracAccountCommitteeAq,
  FracCommitteeAq,
  FracCommitteeStanding,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodVoteCache,
  FracVotingRecord,
} from '../generated/FracDelegationInstanceClient'
import { getConstructorConfig } from '../networkConfig'
import { errorTransformer, wrapErrors } from '../util/wrapErrors'
import { assertUint } from '../util/assertUint'
import { chunk } from '../util/chunk'
import { chunked } from '../util/chunked'
import { committeeIdToRaw } from '../util/comitteeId'
import { ReaderConstructorArgs } from './types'

export class FracDelegationReaderSDK {
  static INSTANCE_APP_SPEC = INSTANCE_APP_SPEC

  public algorand: AlgorandClient
  /** Composed registry reader SDK (roles + accounts + instances + escrow assignments). */
  public registry: FracDelegationRegistryReaderSDK
  /** Registry app ID. */
  public registryAppId: bigint
  public concurrency: number
  public debug?: boolean
  protected readerAccount?: string
  /** instanceNumId → instance contract appId */
  protected instanceAppCache: Map<bigint, bigint> = new Map()
  /** instanceNumId → cached read-only client */
  protected instanceReadClientCache: Map<bigint, FracDelegationInstanceClient> = new Map()

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest)
    this.algorand = algorand
    algorand.setSuggestedParamsCacheTimeout(6000) // 6s or ~2 rounds of cache. reduces GET requests to /params
    algorand.registerErrorTransformer(errorTransformer)
    this.registryAppId = appId
    this.concurrency = concurrency
    this.debug = debug
    this.readerAccount = readerAccount
    this.registry = new FracDelegationRegistryReaderSDK({
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
  get registryReadClient(): FracDelegationRegistryClient {
    return this.registry.readClient
  }

  // ── Registry passthroughs (end-user escrow read) ──────────────────
  // An escrow account self-services its own assignment, so this is forwarded for ergonomics (no
  // `.registry`). Admin/config/analytics reads (getAdmin, getInstances, getAccounts, …) stay on
  // `.registry`.

  /** "Which instance is my account an escrow of?" */
  getEscrowInstance = (...args: Parameters<FracDelegationRegistryReaderSDK['getEscrowInstance']>) =>
    this.registry.getEscrowInstance(...args)

  // ── Instance app resolution ──────────────────────────────────────

  /** Resolve the on-chain app ID for an instanceNumId. Throws if the instance is unknown. */
  @wrapErrors()
  async getInstanceAppId(instanceNumId: bigint | number): Promise<bigint> {
    const id = assertUint(instanceNumId, 16, 'instanceNumId')
    const cached = this.instanceAppCache.get(id)
    if (cached !== undefined) return cached
    const instance = await this.registry.getInstance(id)
    const appId = BigInt(instance?.appId ?? 0)
    if (appId === 0n) throw new Error(`Instance ${id} not found in registry`)
    this.instanceAppCache.set(id, appId)
    return appId
  }

  /** Build (and cache) a read-only per-instance client. */
  protected async getInstanceReadClient(instanceNumId: bigint | number): Promise<FracDelegationInstanceClient> {
    const id = assertUint(instanceNumId, 16, 'instanceNumId')
    const cached = this.instanceReadClientCache.get(id)
    if (cached) return cached
    const appId = await this.getInstanceAppId(id)
    const client = new FracDelegationInstanceClient({
      algorand: this.algorand,
      appId,
      defaultSender: this.readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    })
    this.instanceReadClientCache.set(id, client)
    return client
  }

  // ── Per-instance reads ───────────────────────────────────────────

  /** Bound `FracDelegationRegistry` app id; 0 while unbound. */
  async getInstanceRegistryApp(instanceNumId: bigint | number): Promise<bigint> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const appId = await client.state.global.registryApp()
    return BigInt(appId!)
  }

  /** Resolved instance admin (the registry's `admin`). */
  async getInstanceAdmin(instanceNumId: bigint | number): Promise<string> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client.newGroup().getAdmin({ args: {} }).simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /** Resolved instance operator: local `operator` if set, else the registry's `defaultOperator`. */
  async getInstanceOperator(instanceNumId: bigint | number): Promise<string> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client.newGroup().getOperator({ args: {} }).simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /** Escrow accounts registered against this instance (addresses, in registration order). */
  async getEscrows(instanceNumId: bigint | number): Promise<string[]> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client.newGroup().getEscrows({ args: {} }).simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /**
   * This instance's synced snapshot of a gGov committee, or undefined if `syncCommittee` has
   * never been run for it. `escrowsVotes` is index-synced with `getEscrows()`.
   */
  async getCommittee(
    instanceNumId: bigint | number,
    committeeId: Uint8Array | string,
  ): Promise<FracInstanceCommittee | undefined> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getCommittee({ args: { committeeId: committeeIdToRaw(committeeId) } })
      .simulate(SIMULATE_PARAMS)
    const committee = returns[0]!
    // Sentinel: committeeNumId 0 is never assigned by the gGov registry, so it marks "not synced".
    return Number(committee.committeeNumId) === 0 ? undefined : committee
  }

  /**
   * Batch `getCommittee` via `logCommittees`: index-aligned with `committeeIds`, `undefined` for a
   * committee this instance has never synced. Prefer this over N x `getCommittee` for many ids.
   */
  async getCommittees(
    instanceNumId: bigint | number,
    committeeIds: (Uint8Array | string)[],
  ): Promise<(FracInstanceCommittee | undefined)[]> {
    const client = await this.getInstanceReadClient(instanceNumId)
    return this._getCommitteesChunked(committeeIds.map(committeeIdToRaw), client)
  }

  /**
   * Each simulate group packs up to two 63-id `logCommittees` calls: every id is one `committees`
   * box reference, and even with `allowUnnamedResources` a simulate group carries at most 128
   * unnamed refs. The decorator fans out larger requests concurrently.
   */
  @chunked(126)
  private async _getCommitteesChunked(
    committeeIds: Uint8Array[],
    client: FracDelegationInstanceClient,
  ): Promise<(FracInstanceCommittee | undefined)[]> {
    if (committeeIds.length === 0) return []
    let builder: FracDelegationInstanceComposer<any> = client.newGroup()
    for (const ids of chunk(committeeIds, 63)) {
      builder = builder.logCommittees({ args: { committeeIds: ids } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map((log) => {
      const committee = getABIDecodedValue(
        new Uint8Array(log!),
        'FracInstanceCommittee',
        client.appSpec.structs,
      ) as FracInstanceCommittee
      return Number(committee.committeeNumId) === 0 ? undefined : committee
    })
  }

  /**
   * This instance's AlgoQuarters ledger for a committee, or undefined if `startAqIngest` has never
   * opened one for it.
   *
   * Keyed by the committee's gGov *numeric* ID, not its 32-byte ID — `getCommittee(instanceNumId,
   * committeeId)` resolves that (`committeeNumId`), and `startAqIngest` returns it. Ingestion is
   * complete when both `ingestedAq === totalAq` and `numAccounts === totalAccounts`.
   */
  async getCommitteeAq(
    instanceNumId: bigint | number,
    committeeNumId: bigint | number,
  ): Promise<FracCommitteeAq | undefined> {
    const committeeNumIdArg = assertUint(committeeNumId, 16, 'committeeNumId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getCommitteeAq({ args: { committeeNumId: committeeNumIdArg, mustBeComplete: false } })
      .simulate(SIMULATE_PARAMS)
    const aq = returns[0]!
    // Sentinel: totalAq 0 is never written by `startAqIngest`, so it marks "no ledger".
    return Number(aq.totalAq) === 0 ? undefined : aq
  }

  /**
   * This instance's headline position in a committee: the synced snapshot's `totalVotes` joined
   * with the AlgoQuarters ledger behind it, in one call — `getCommittee` + `getCommitteeAq` without
   * the round-trip between them (`committeeAq` is keyed by the numeric ID only the first read
   * yields). Omits `escrowsVotes`; use `getCommittee` when the per-escrow split is wanted.
   *
   * Undefined when the instance has never synced the committee. A synced committee with no ledger
   * open comes back with real `totalVotes` and `totalAq` 0 — the two states are distinct.
   *
   * The cross-instance form of this is the registry's `getInstanceCommitteeStandings`, which drives
   * the same instance method through `logInstanceCommittees`.
   */
  async getCommitteeStanding(
    instanceNumId: bigint | number,
    committeeId: Uint8Array | string,
  ): Promise<FracCommitteeStanding | undefined> {
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getCommitteeStanding({ args: { committeeId: committeeIdToRaw(committeeId) } })
      .simulate(SIMULATE_PARAMS)
    const standing = returns[0]!
    // Sentinel: committeeNumId 0 is never assigned by the gGov registry, so it marks "not synced".
    return Number(standing.committeeNumId) === 0 ? undefined : standing
  }

  /**
   * `accountId`'s ingested AlgoQuarters in a committee, or 0 if it has none — mirroring the
   * contract's non-throwing `tryGetAccountAq`, since an account with no AlgoQuarters simply has no
   * weight. Account IDs come from the frac registry (`FracDelegationRegistrySDK.getAccountIdMap`).
   */
  async getAccountAq(
    instanceNumId: bigint | number,
    accountId: bigint | number,
    committeeNumId: bigint | number,
  ): Promise<number> {
    const accountIdArg = assertUint(accountId, 32, 'accountId')
    const committeeNumIdArg = assertUint(committeeNumId, 16, 'committeeNumId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .tryGetAccountAq({ args: { accountId: accountIdArg, committeeNumId: committeeNumIdArg } })
      .simulate(SIMULATE_PARAMS)
    return Number(returns[0]!)
  }

  /**
   * Batch `getAccountAq` via `logAccountAqs`: index-aligned with `accountIds`, 0 for an account
   * with no AQ in the committee. Account IDs come from `registry.getAccountIdMap`.
   */
  async getAccountAqs(
    instanceNumId: bigint | number,
    committeeNumId: bigint | number,
    accountIds: (bigint | number)[],
  ): Promise<number[]> {
    assertUint(committeeNumId, 16, 'committeeNumId')
    accountIds.forEach((accountId, i) => assertUint(accountId, 32, `accountIds[${i}]`))
    const client = await this.getInstanceReadClient(instanceNumId)
    return this._getAccountAqsChunked(accountIds, client, committeeNumId)
  }

  /**
   * Each simulate group packs up to two 63-id `logAccountAqs` calls: every id is one `accountAq`
   * box reference, and even with `allowUnnamedResources` a simulate group carries at most 128
   * unnamed refs (8 per txn x the 16-txn group capacity). The decorator fans out larger requests
   * concurrently. 126 used vs 128 possible as the additional app call for only 2 accounts is
   * not worth the overhead.
   */
  @chunked(126)
  private async _getAccountAqsChunked(
    accountIds: (bigint | number)[],
    client: FracDelegationInstanceClient,
    committeeNumId: bigint | number,
  ): Promise<number[]> {
    if (accountIds.length === 0) return []
    let builder: FracDelegationInstanceComposer<any> = client.newGroup()
    for (const ids of chunk(accountIds, 63)) {
      builder = builder.logAccountAqs({ args: { committeeNumId, accountIds: ids.map(BigInt) } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map((log) => Number(getABIDecodedValue(new Uint8Array(log!), 'uint32', client.appSpec.structs)))
  }

  /**
   * Map each account address to its ingested AQ in the committee: 0 if unregistered on the frac
   * registry or not ingested. Defaults to every registered account when `accounts` is omitted.
   */
  async getAccountAqMap(
    instanceNumId: bigint | number,
    committeeNumId: bigint | number,
    accounts?: string[],
  ): Promise<Map<string, number>> {
    accounts = accounts ?? (await this.registry.getAccounts())
    const idMap = await this.registry.getAccountIdMap(accounts)
    const registered = accounts.filter((account) => (idMap.get(account) ?? 0) > 0)
    const aqs = await this.getAccountAqs(
      instanceNumId,
      committeeNumId,
      registered.map((account) => idMap.get(account)!),
    )
    const map = new Map<string, number>(accounts.map((account) => [account, 0]))
    registered.forEach((account, index) => map.set(account, aqs[index]))
    return map
  }

  /**
   * Bundled read of one account's AlgoQuarters standing in a committee: the instance's identity, the
   * committee's identity, and the account's weight (`userAq`) against the committee total (`totalAq`)
   * in a single simulate. `accountId` is the frac registry numeric ID (see `registry.getAccountIdMap`).
   *
   * Non-throwing: an unsynced committee comes back with `committeeNumId` 0 and `userAq`/`totalAq` 0.
   */
  async getAccountCommitteeAq(
    instanceNumId: bigint | number,
    accountId: bigint | number,
    committeeId: Uint8Array | string,
  ): Promise<FracAccountCommitteeAq> {
    const accountIdArg = assertUint(accountId, 32, 'accountId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getAccountCommitteeAq({ args: { accountId: accountIdArg, committeeId: committeeIdToRaw(committeeId) } })
      .simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /**
   * This instance's synced snapshot of a gGov period, or undefined if `syncPeriod` has never been
   * run for it.
   */
  async getPeriod(instanceNumId: bigint | number, periodId: bigint | number): Promise<FracInstancePeriod | undefined> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getPeriod({ args: { periodId: periodIdArg } })
      .simulate(SIMULATE_PARAMS)
    const period = returns[0]!
    // Sentinel: periodAppId 0 is never written by `syncPeriod`, so it marks "not synced".
    return period.periodAppId === 0n ? undefined : period
  }

  /**
   * Batch `getPeriod` via `logPeriods`: index-aligned with `periodIds`, `undefined` for a period
   * this instance has never synced. Prefer this over N x `getPeriod` for many ids.
   */
  async getPeriods(
    instanceNumId: bigint | number,
    periodIds: (bigint | number)[],
  ): Promise<(FracInstancePeriod | undefined)[]> {
    periodIds.forEach((periodId, i) => assertUint(periodId, 32, `periodIds[${i}]`))
    const client = await this.getInstanceReadClient(instanceNumId)
    return this._getPeriodsChunked(periodIds, client)
  }

  /**
   * Each simulate group packs up to two 63-id `logPeriods` calls: every id is one `periods` box
   * reference, bounded by the 128 unnamed-ref simulate cap. The decorator fans out larger requests.
   */
  @chunked(126)
  private async _getPeriodsChunked(
    periodIds: (bigint | number)[],
    client: FracDelegationInstanceClient,
  ): Promise<(FracInstancePeriod | undefined)[]> {
    if (periodIds.length === 0) return []
    let builder: FracDelegationInstanceComposer<any> = client.newGroup()
    for (const ids of chunk(periodIds, 63)) {
      builder = builder.logPeriods({ args: { periodIds: ids.map(BigInt) } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map((log) => {
      const period = getABIDecodedValue(
        new Uint8Array(log!),
        'FracInstancePeriod',
        client.appSpec.structs,
      ) as FracInstancePeriod
      return period.periodAppId === 0n ? undefined : period
    })
  }

  /**
   * This instance's aggregate vote tallies for a gGov period, or undefined if `syncPeriod` has
   * never been run for it. Both tallies are [topic][option], shaped to the period's topics.
   */
  async getPeriodVoteCache(
    instanceNumId: bigint | number,
    periodId: bigint | number,
  ): Promise<FracPeriodVoteCache | undefined> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getPeriodVoteCache({ args: { periodId: periodIdArg } })
      .simulate(SIMULATE_PARAMS)
    const cache = returns[0]!
    // Sentinel: a synced period fills `internal` to its topic shape, so empty means "not synced".
    return cache.internal.length === 0 ? undefined : cache
  }

  /**
   * An account's internal vote for a gGov period ([topic][option] AlgoQuarters, exactly as
   * submitted), or undefined if it has not voted. `accountId` is the frac registry numeric ID.
   */
  async getVotingRecord(
    instanceNumId: bigint | number,
    periodId: bigint | number,
    accountId: bigint | number,
  ): Promise<FracVotingRecord | undefined> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const accountIdArg = assertUint(accountId, 32, 'accountId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getVotingRecord({ args: { periodId: periodIdArg, accountId: accountIdArg } })
      .simulate(SIMULATE_PARAMS)
    const record = returns[0]!
    // Sentinel: a cast vote has one row per topic, so empty `topicVotes` means "has not voted".
    return record.topicVotes.length === 0 ? undefined : record
  }

  /**
   * Whether `senderAccount` may cast `voterAccount`'s internal vote on a gGov period, and the
   * AlgoQuarters weight it would carry — the read-only mirror of `vote`'s gates, like
   * `GGovReaderSDK.canVote` is for the period contract. `senderAccount` defaults to `voterAccount`
   * (self-vote); pass a delegatee to check a delegated vote, which also applies the override guard
   * (a delegatee cannot overwrite a vote the owner cast directly).
   *
   * Returns `[false, 0n]` for every rejection — the contract does not distinguish them.
   */
  async canVote(
    instanceNumId: bigint | number,
    periodId: bigint | number,
    voterAccount: string,
    senderAccount?: string,
  ): Promise<[boolean, bigint]> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .canVote({
        args: { voterAccount, senderAccount: senderAccount ?? voterAccount, periodId: periodIdArg },
        // outer call + up to 2 inner calls (gGov registry getDelegate when delegated, frac registry getAccount)
        staticFee: (3 * 1000).microAlgo(),
      })
      .simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /**
   * One escrow's external gGov votes for a gGov period ([topic][option]), or undefined if that
   * escrow has no box for the period. `escrowIndex` is the index into `getEscrows()`.
   */
  async getPeriodEscrowVotes(
    instanceNumId: bigint | number,
    periodId: bigint | number,
    escrowIndex: bigint | number,
  ): Promise<FracEscrowVotes | undefined> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const escrowIndexArg = assertUint(escrowIndex, 8, 'escrowIndex')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { returns } = await client
      .newGroup()
      .getPeriodEscrowVotes({ args: { periodId: periodIdArg, escrowIndex: escrowIndexArg } })
      .simulate(SIMULATE_PARAMS)
    const escrowVotes = returns[0]!
    // Sentinel: a synced period fills each escrow box to its topic shape, so empty means "no box".
    return escrowVotes.votes.length === 0 ? undefined : escrowVotes
  }

  /**
   * This instance's entire voting state for a gGov period, fetched in a single simulate via
   * `logPeriodVotingState`, or undefined if `syncPeriod` has never been run for it.
   *
   * One call, one round-trip, regardless of escrow count — preferred over `getPeriodVoteCache` +
   * N x `getPeriodEscrowVotes`, which is N+1 box reads and cannot be read atomically.
   *
   * `escrowVotes` is index-aligned with `getEscrows()`; every tally is [topic][option].
   */
  async getPeriodVotingState(
    instanceNumId: bigint | number,
    periodId: bigint | number,
  ): Promise<
    | {
        period: FracInstancePeriod
        internal: number[][]
        ggovTotals: number[][]
        escrowVotes: number[][][]
      }
    | undefined
  > {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const client = await this.getInstanceReadClient(instanceNumId)
    const { confirmations } = await client
      .newGroup()
      .logPeriodVotingState({ args: { periodId: periodIdArg } })
      .simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    // The method logs nothing at all when the period has never been synced.
    if (logs.length === 0) return undefined

    const decode = <T>(raw: Uint8Array | number[], struct: string) =>
      getABIDecodedValue(new Uint8Array(raw), struct, client.appSpec.structs) as T

    const period = decode<FracInstancePeriod>(logs[0]!, 'FracInstancePeriod')
    const cache = decode<FracPeriodVoteCache>(logs[1]!, 'FracPeriodVoteCache')
    const escrowVotes = logs.slice(2).map((l) => decode<FracEscrowVotes>(l!, 'FracEscrowVotes').votes)

    return { period, internal: cache.internal, ggovTotals: cache.ggovTotals, escrowVotes }
  }

  /** Read all instance global state, plus the current network round. */
  async getInstanceGlobalState(instanceNumId: bigint | number) {
    const client = await this.getInstanceReadClient(instanceNumId)
    // TODO not atomic, could simulate a logGlobalState to get the current round atomically
    const [state, status] = await Promise.all([client.state.global.getAll(), this.algorand.client.algod.status().do()])
    return { ...state, currentRound: status.lastRound }
  }
}
