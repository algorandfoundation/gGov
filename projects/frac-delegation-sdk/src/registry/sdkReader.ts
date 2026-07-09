import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { makeEmptyTransactionSigner } from 'algosdk'
import { FracDelegationRegistryClient, APP_SPEC } from '../generated/FracDelegationRegistryClient'
import { getConstructorConfig } from '../networkConfig'
import { ReaderConstructorArgs } from './types'
import { errorTransformer } from '../util/wrapErrors'

export class FracDelegationRegistryReaderSDK {
  static APP_SPEC = APP_SPEC

  public algorand: AlgorandClient
  public appId: bigint
  public readClient: FracDelegationRegistryClient
  public concurrency: number
  public debug?: boolean

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest)
    this.algorand = algorand
    algorand.setSuggestedParamsCacheTimeout(6000) // 6s or ~2 rounds of cache. reduces GET requests to /params
    algorand.registerErrorTransformer(errorTransformer)
    this.appId = appId
    this.concurrency = concurrency
    this.debug = debug
    this.readClient = new FracDelegationRegistryClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    })
  }

  /** Frac-system-wide admin address. */
  async getAdmin(): Promise<string> {
    const admin = await this.readClient.state.global.admin()
    return admin!
  }

  /** Fallback operator for frac instances. */
  async getDefaultOperator(): Promise<string> {
    const defaultOperator = await this.readClient.state.global.defaultOperator()
    return defaultOperator!
  }

  /** Configured gGov registry app id, or undefined while unset. */
  async getGGovRegistryApp(): Promise<bigint | undefined> {
    const appId = await this.readClient.state.global.gGovRegistryApp()
    return appId === undefined ? undefined : BigInt(appId)
  }

  /** Read all registry global state, plus the current network round. */
  async getGlobalState() {
    // TODO not atomic, could simulate a logGlobalState to get the current round atomically
    const [state, status] = await Promise.all([
      this.readClient.state.global.getAll(),
      this.algorand.client.algod.status().do(),
    ])
    return { ...state, currentRound: status.lastRound }
  }
}
