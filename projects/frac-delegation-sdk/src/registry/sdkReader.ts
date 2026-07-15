import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { encodeAddress, makeEmptyTransactionSigner } from 'algosdk'
import pMap from 'p-map'
import {
  FracDelegationRegistryClient,
  FracDelegationRegistryComposer,
  FracInstance,
  FracRegAccount,
  APP_SPEC,
} from '../generated/FracDelegationRegistryClient'
import { getConstructorConfig } from '../networkConfig'
import { ReaderConstructorArgs } from './types'
import { chunk } from '../util/chunk'
import { chunked } from '../util/chunked'
import { errorTransformer } from '../util/wrapErrors'
import { undefinedIfBoxMissing } from '../util/boxes'
import { SIMULATE_PARAMS } from '../util/increaseBudget'

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

  /** Registered instance record by numeric id, or undefined if no such instance. */
  async getInstance(instanceNumId: number | bigint) {
    return undefinedIfBoxMissing(() => this.readClient.state.box.instances.value(instanceNumId))
  }

  /** Instance numeric ID an escrow account is assigned to, or undefined if unassigned. */
  async getEscrowInstance(account: string): Promise<number | undefined> {
    return undefinedIfBoxMissing(() => this.readClient.state.box.escrows.value(account))
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

  // ── Accounts ─────────────────────────────────────────────────────

  /** List account addresses registered on the registry (box-name scan). */
  async getAccounts(): Promise<string[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId)
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 97 && nameRaw.length === 33) // 'a' prefix + 32-byte address
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(1)).toString())
  }

  /**
   * Map each account address to its numeric registry account ID.
   * Defaults to every registered account when `accounts` is omitted.
   */
  async getAccountIdMap(accounts?: string[]): Promise<Map<string, number>> {
    accounts = accounts ?? (await this.getAccounts())
    const fracRegAccounts = await this._getFracRegAccountsChunked(accounts)
    return new Map(accounts.map((account, index) => [account, fracRegAccounts[index].accountId]))
  }

  /**
   * Map each account address to its full `FracRegAccount` record (accountId + instance numeric IDs).
   * Defaults to every registered account when `accounts` is omitted.
   */
  async getFracRegAccountsMap(accounts?: string[]): Promise<Map<string, FracRegAccount>> {
    accounts = accounts ?? (await this.getAccounts())
    const fracRegAccounts = await this._getFracRegAccountsChunked(accounts)
    return new Map(accounts.map((account, index) => [account, fracRegAccounts[index]]))
  }

  /**
   * Batch-read `FracRegAccount` records via `logAccounts`, index-aligned with `accounts`.
   * Unknown accounts come back with accountId 0 and no instances. Each simulate group packs
   * up to two 63-account `logAccounts` calls; the decorator fans out larger requests concurrently.
   */
  @chunked(126)
  private async _getFracRegAccountsChunked(accounts: string[]): Promise<FracRegAccount[]> {
    if (accounts.length === 0) return []
    const accountArgs = chunk(accounts, 63)
    let builder: FracDelegationRegistryComposer<any> = this.readClient.newGroup()
    for (const accountChunk of accountArgs) {
      builder = builder.logAccounts({ args: { accounts: accountChunk } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map(
      (log) =>
        getABIDecodedValue(new Uint8Array(log!), 'FracRegAccount', this.readClient.appSpec.structs) as FracRegAccount,
    )
  }

  // ── Instances ────────────────────────────────────────────────────

  /**
   * All recorded instances, keyed by `instanceNumId`. The `instances` box entry is never removed
   * once created (the contract has no on-chain instance-removal path), so this may include
   * entries for instance apps that have been deleted.
   */
  async getInstances(): Promise<Map<number, FracInstance>> {
    return this.readClient.state.box.instances.getMap()
  }

  /** Whether the given instance's app id still exists on-chain. */
  async instanceAppExists(appId: bigint | number): Promise<boolean> {
    try {
      await this.algorand.app.getById(BigInt(appId))
      return true
    } catch (e: any) {
      if (e?.status === 404) return false
      throw e
    }
  }

  /** Wrap `getInstances()` and filter to instances whose app still exists on-chain. */
  async getExistingInstances(): Promise<Map<number, FracInstance>> {
    const instances = await this.getInstances()
    const entries = await pMap(
      [...instances],
      async ([id, instance]) => ((await this.instanceAppExists(instance.appId)) ? ([id, instance] as const) : null),
      { concurrency: this.concurrency },
    )
    return new Map(entries.filter((entry): entry is readonly [number, FracInstance] => entry !== null))
  }
}
