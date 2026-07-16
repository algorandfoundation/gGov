import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { makeEmptyTransactionSigner } from 'algosdk'
import { FracDelegationRegistryReaderSDK, SIMULATE_PARAMS } from '../registry'
import { FracDelegationRegistryClient } from '../generated/FracDelegationRegistryClient'
import {
  FracDelegationInstanceClient,
  APP_SPEC as INSTANCE_APP_SPEC,
  FracCommitteeAq,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodVoteCache,
  FracVotingRecord,
} from '../generated/FracDelegationInstanceClient'
import { getConstructorConfig } from '../networkConfig'
import { errorTransformer, wrapErrors } from '../util/wrapErrors'
import { undefinedIfBoxMissing } from '../util/boxes'
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
    const id = BigInt(instanceNumId)
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
    const id = BigInt(instanceNumId)
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
    // The box only exists once the first escrow is registered; treat "not found" as empty.
    const escrows = await undefinedIfBoxMissing(() => client.state.box.escrows())
    return escrows ?? []
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
    return undefinedIfBoxMissing(() => client.state.box.committees.value(committeeIdToRaw(committeeId)))
  }

  /**
   * This instance's AlgoQuarters ledger for a committee, or undefined if `startAqIngest` has never
   * opened one for it.
   *
   * Keyed by the committee's gGov *numeric* ID, not its 32-byte ID — `getCommittee(instanceNumId,
   * committeeId)` resolves that (`committeeNumId`), and `startAqIngest` returns it. Ingestion is
   * complete when `ingestedAq === totalAq`.
   */
  async getCommitteeAq(
    instanceNumId: bigint | number,
    committeeNumId: bigint | number,
  ): Promise<FracCommitteeAq | undefined> {
    const client = await this.getInstanceReadClient(instanceNumId)
    return undefinedIfBoxMissing(() => client.state.box.committeeAq.value(BigInt(committeeNumId)))
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
    const client = await this.getInstanceReadClient(instanceNumId)
    const aq = await undefinedIfBoxMissing(() =>
      client.state.box.accountAq.value([BigInt(accountId), BigInt(committeeNumId)]),
    )
    return aq ?? 0
  }

  /**
   * This instance's synced snapshot of a gGov period, or undefined if `syncPeriod` has never been
   * run for it.
   */
  async getPeriod(instanceNumId: bigint | number, periodId: bigint | number): Promise<FracInstancePeriod | undefined> {
    const client = await this.getInstanceReadClient(instanceNumId)
    return undefinedIfBoxMissing(() => client.state.box.periods.value(BigInt(periodId)))
  }

  /**
   * This instance's aggregate vote tallies for a gGov period, or undefined if `syncPeriod` has
   * never been run for it. Both tallies are [topic][option], shaped to the period's topics.
   */
  async getPeriodVoteCache(
    instanceNumId: bigint | number,
    periodId: bigint | number,
  ): Promise<FracPeriodVoteCache | undefined> {
    const client = await this.getInstanceReadClient(instanceNumId)
    return undefinedIfBoxMissing(() => client.state.box.periodVoteCache.value(BigInt(periodId)))
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
    const client = await this.getInstanceReadClient(instanceNumId)
    return undefinedIfBoxMissing(() => client.state.box.votingRecords.value([BigInt(periodId), BigInt(accountId)]))
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
    const client = await this.getInstanceReadClient(instanceNumId)
    return undefinedIfBoxMissing(() =>
      client.state.box.periodEscrowVotes.value([BigInt(periodId), BigInt(escrowIndex)]),
    )
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
    const client = await this.getInstanceReadClient(instanceNumId)
    const { confirmations } = await client
      .newGroup()
      .logPeriodVotingState({ args: { periodId: BigInt(periodId) } })
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
