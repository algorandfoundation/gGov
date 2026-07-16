import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { makeEmptyTransactionSigner } from 'algosdk'
import {
  FracDelegationInstanceClient,
  APP_SPEC,
  FracEscrowVotes,
  FracInstanceCommittee,
  FracInstancePeriod,
  FracPeriodVoteCache,
} from '../generated/FracDelegationInstanceClient'
import { defaultReaderAccount } from '../networkConfig'
import { SIMULATE_PARAMS } from '../util/increaseBudget'
import { errorTransformer } from '../util/wrapErrors'
import { undefinedIfBoxMissing } from '../util/boxes'
import { committeeIdToRaw } from '../util/comitteeId'
import { InstanceReaderConstructorArgs } from './types'

export class FracDelegationReaderSDK {
  static APP_SPEC = APP_SPEC

  public algorand: AlgorandClient
  public appId: bigint
  public readClient: FracDelegationInstanceClient
  public concurrency: number
  public debug?: boolean
  protected readerAccount: string

  constructor({ algorand, instanceAppId, readerAccount, concurrency = 4, debug }: InstanceReaderConstructorArgs) {
    this.algorand = algorand
    algorand.setSuggestedParamsCacheTimeout(6000) // 6s or ~2 rounds of cache. reduces GET requests to /params
    algorand.registerErrorTransformer(errorTransformer)
    this.appId = BigInt(instanceAppId)
    this.concurrency = concurrency
    this.debug = debug
    this.readerAccount = readerAccount ?? defaultReaderAccount
    this.readClient = new FracDelegationInstanceClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: this.readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    })
  }

  /** Bound `FracDelegationRegistry` app id; 0 while unbound. */
  async getRegistryApp(): Promise<bigint> {
    const appId = await this.readClient.state.global.registryApp()
    return BigInt(appId!)
  }

  /** Resolved instance admin (the registry's `admin`). */
  async getAdmin(): Promise<string> {
    const { returns } = await this.readClient.newGroup().getAdmin({ args: {} }).simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /** Resolved instance operator: local `operator` if set, else the registry's `defaultOperator`. */
  async getOperator(): Promise<string> {
    const { returns } = await this.readClient.newGroup().getOperator({ args: {} }).simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /** Escrow accounts registered against this instance (addresses, in registration order). */
  async getEscrows(): Promise<string[]> {
    // The box only exists once the first escrow is registered; treat "not found" as empty.
    const escrows = await undefinedIfBoxMissing(() => this.readClient.state.box.escrows())
    return escrows ?? []
  }

  /**
   * This instance's synced snapshot of a gGov committee, or undefined if `syncCommittee` has
   * never been run for it. `escrowsVotes` is index-synced with `getEscrows()`.
   */
  async getCommittee(committeeId: Uint8Array | string): Promise<FracInstanceCommittee | undefined> {
    return undefinedIfBoxMissing(() => this.readClient.state.box.committees.value(committeeIdToRaw(committeeId)))
  }

  /**
   * This instance's synced snapshot of a gGov period, or undefined if `syncPeriod` has never been
   * run for it.
   */
  async getPeriod(periodId: bigint | number): Promise<FracInstancePeriod | undefined> {
    return undefinedIfBoxMissing(() => this.readClient.state.box.periods.value(BigInt(periodId)))
  }

  /**
   * This instance's aggregate vote tallies for a gGov period, or undefined if `syncPeriod` has
   * never been run for it. Both tallies are [topic][option], shaped to the period's topics.
   */
  async getPeriodVoteCache(periodId: bigint | number): Promise<FracPeriodVoteCache | undefined> {
    return undefinedIfBoxMissing(() => this.readClient.state.box.periodVoteCache.value(BigInt(periodId)))
  }

  /**
   * One escrow's external gGov votes for a gGov period ([topic][option]), or undefined if that
   * escrow has no box for the period. `escrowIndex` is the index into `getEscrows()`.
   */
  async getPeriodEscrowVotes(
    periodId: bigint | number,
    escrowIndex: bigint | number,
  ): Promise<FracEscrowVotes | undefined> {
    return undefinedIfBoxMissing(() =>
      this.readClient.state.box.periodEscrowVotes.value([BigInt(periodId), BigInt(escrowIndex)]),
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
  async getPeriodVotingState(periodId: bigint | number): Promise<
    | {
        period: FracInstancePeriod
        internal: number[][]
        ggovTotals: number[][]
        escrowVotes: number[][][]
      }
    | undefined
  > {
    const { confirmations } = await this.readClient
      .newGroup()
      .logPeriodVotingState({ args: { periodId: BigInt(periodId) } })
      .simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    // The method logs nothing at all when the period has never been synced.
    if (logs.length === 0) return undefined

    const decode = <T>(raw: Uint8Array | number[], struct: string) =>
      getABIDecodedValue(new Uint8Array(raw), struct, this.readClient.appSpec.structs) as T

    const period = decode<FracInstancePeriod>(logs[0]!, 'FracInstancePeriod')
    const cache = decode<FracPeriodVoteCache>(logs[1]!, 'FracPeriodVoteCache')
    const escrowVotes = logs.slice(2).map((l) => decode<FracEscrowVotes>(l!, 'FracEscrowVotes').votes)

    return { period, internal: cache.internal, ggovTotals: cache.ggovTotals, escrowVotes }
  }

  /** Read all instance global state, plus the current network round. */
  async getGlobalState() {
    // TODO not atomic, could simulate a logGlobalState to get the current round atomically
    const [state, status] = await Promise.all([
      this.readClient.state.global.getAll(),
      this.algorand.client.algod.status().do(),
    ])
    return { ...state, currentRound: status.lastRound }
  }
}
