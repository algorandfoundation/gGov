import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { makeEmptyTransactionSigner } from 'algosdk'
import { FracDelegationInstanceClient, APP_SPEC } from '../generated/FracDelegationInstanceClient'
import { defaultReaderAccount } from '../networkConfig'
import { SIMULATE_PARAMS } from '../util/increaseBudget'
import { errorTransformer } from '../util/wrapErrors'
import { undefinedIfBoxMissing } from '../util/boxes'
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
