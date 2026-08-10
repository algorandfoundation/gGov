import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { encodeAddress, makeEmptyTransactionSigner } from 'algosdk'
import pMap from 'p-map'
import {
  FracDelegationRegistryClient,
  FracDelegationRegistryComposer,
  FracAccountVotingRecord,
  FracEscrowInstance,
  FracInstance,
  FracRegAccount,
  APP_SPEC,
} from '../generated/FracDelegationRegistryClient'
import { APP_SPEC as INSTANCE_APP_SPEC, FracAccountCommitteeAq } from '../generated/FracDelegationInstanceClient'
import { getConstructorConfig } from '../networkConfig'
import { ReaderConstructorArgs } from './types'
import { assertUint } from '../util/assertUint'
import { chunk } from '../util/chunk'
import { chunked } from '../util/chunked'
import { committeeIdToRaw } from '../util/comitteeId'
import { errorTransformer } from '../util/wrapErrors'
import { undefinedIfBoxMissing } from '../util/boxes'
import { SIMULATE_PARAMS } from '../util/increaseBudget'

/**
 * Max instances per page for the registry's paged cross-instance log methods. Each page is a single
 * readonly simulate app call, and simulate with `allowUnnamedResources` gives one app call a flat
 * pool of 128 unnamed resource references (boxes + foreign apps) — the AVM's 8-box/8-foreign-app
 * per-transaction array caps do not bind here, they are reported as unnamed resources instead. So a
 * page covers `floor((128 - fixed) / perInstance)` instances and longer instance lists span
 * successive pages.
 *
 * Fixed cost, both methods: 1 reference — the caller's `accounts` box, read once by
 * `getAccountIfExists`.
 *
 * `logAccountInstanceAQ` — 5 references per instance: the registry `instances` box, the instance app
 * (its inner call), and the 3 boxes `getAccountCommitteeAq` reads on that instance (`committees`,
 * `committeeAq`, `accountAq`). => floor((128 - 1) / 5) = 25.
 *
 * `logAccountVotingRecords` — 3 references per instance: the registry `instances` box, the instance
 * app (its inner call), and the 1 box `getVotingRecord` reads on that instance (`votingRecords`).
 * => floor((128 - 1) / 3) = 42.
 */
const AQ_PAGE_SIZE = 25
const VOTING_RECORDS_PAGE_SIZE = 42

/**
 * Struct layouts for decoding the per-instance log payloads of `logAccountInstanceAQ`
 * (`FracAccountCommitteeAq`) and `logAccountVotingRecords` (`FracAccountVotingRecord`).
 * `getABIDecodedValue` resolves struct names from this map. Both structs are the return type of a
 * readonly getter — `getAccountCommitteeAq` on the instance, `getAccountVotingRecord` on the
 * registry — so each is registered in its contract's ARC-56 and sourced from the generated
 * `APP_SPEC.structs` here rather than hand-declared.
 */
const CROSS_INSTANCE_STRUCTS = {
  ...INSTANCE_APP_SPEC.structs,
  ...APP_SPEC.structs,
}

export class FracDelegationRegistryReaderSDK {
  static APP_SPEC = APP_SPEC

  public algorand: AlgorandClient
  public appId: bigint
  public readClient: FracDelegationRegistryClient
  public concurrency: number
  public debug?: boolean

  /** Per-page instance counts for the paged cross-instance log methods (see the constants above).
   *  Mutable so a caller can dial them down (or a test can force paging with few instances). */
  public aqPageSize = AQ_PAGE_SIZE
  public votingRecordsPageSize = VOTING_RECORDS_PAGE_SIZE

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

  /** Configured gGov registry app id; `0n` while unset (sentinel). */
  async getGGovRegistryApp(): Promise<bigint> {
    return (await this.readClient.state.global.gGovRegistryApp()) ?? 0n
  }

  /** microALGO the registry sends an instance per `requestMBR` top-up. */
  async getMBRTopUp(): Promise<bigint> {
    return (await this.readClient.state.global.mbrTopUp()) ?? 0n
  }

  /** Registered instance record by numeric id, or undefined if no such instance. */
  async getInstance(instanceNumId: number | bigint) {
    const id = assertUint(instanceNumId, 16, 'instanceNumId')
    return undefinedIfBoxMissing(() => this.readClient.state.box.instances.value(id))
  }

  /** Instance numeric ID an escrow account is assigned to, or undefined if unassigned. */
  async getEscrowInstance(account: string): Promise<number | undefined> {
    return undefinedIfBoxMissing(() => this.readClient.state.box.escrows.value(account))
  }

  /**
   * Richer resolution of an escrow's assignment, returning the full `FracEscrowInstance` record,
   * or undefined if the escrow is unassigned. Unlike `getEscrowInstance` (a direct box read of
   * just the numeric ID), this also resolves the instance app ID, in one simulate call.
   */
  async getEscrow(account: string): Promise<FracEscrowInstance | undefined> {
    const { return: result } = await this.readClient.send.getEscrow({ args: { account } })
    return result!.instanceNumId === 0 ? undefined : result!
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

  /**
   * An account's AlgoQuarters standing in gGov committee `committeeId` across every frac instance it
   * belongs to — one `FracAccountCommitteeAq` per instance, in the account's `instanceNumIds` order.
   * Each entry joins the instance's identity, the committee's local numeric ID, and the account's
   * weight (`userAq`) against the committee total (`totalAq`).
   *
   * Drives the registry's paged `logAccountInstanceAQ`: every page inner-calls its instances, so the
   * page size is bounded by the simulate unnamed-reference budget (`aqPageSize`) and long instance
   * lists span multiple simulate round-trips. Empty if the account is not registered; per instance,
   * an unsynced committee comes back with `committeeNumId`/`userAq`/`totalAq` 0.
   */
  async getAccountInstanceAQs(account: string, committeeId: Uint8Array | string): Promise<FracAccountCommitteeAq[]> {
    const committeeIdRaw = committeeIdToRaw(committeeId)
    return this._pageAccountInstanceLogs<FracAccountCommitteeAq>(
      this.aqPageSize,
      (limit, offset) =>
        this.readClient.newGroup().logAccountInstanceAq({
          args: { account, committeeId: committeeIdRaw, limit, offset },
          staticFee: ((limit + 1) * 1000).microAlgo(),
        }),
      'FracAccountCommitteeAq',
    )
  }

  /**
   * An account's internal vote records for gGov period `periodId` across every frac instance it
   * belongs to — one `FracAccountVotingRecord` (instance identity + `topicVotes`) per instance, in
   * the account's `instanceNumIds` order. The simpler sibling of `getAccountInstanceAQs`.
   *
   * Drives the registry's paged `logAccountVotingRecords` the same way. Empty if the account is not
   * registered; an instance where the account has not voted for the period comes back with empty
   * `topicVotes`.
   */
  async getAccountVotingRecords(account: string, periodId: bigint | number): Promise<FracAccountVotingRecord[]> {
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    return this._pageAccountInstanceLogs<FracAccountVotingRecord>(
      this.votingRecordsPageSize,
      (limit, offset) =>
        this.readClient.newGroup().logAccountVotingRecords({
          args: { account, periodId: periodIdArg, limit, offset },
          staticFee: ((limit + 1) * 1000).microAlgo(),
        }),
      'FracAccountVotingRecord',
    )
  }

  /**
   * Read one account's internal vote record for gGov period `periodId` in a single frac instance,
   * tagged with the instance's identity. The singular counterpart of `getAccountVotingRecords`:
   * returns one `FracAccountVotingRecord` directly (no paging) for a known `instanceNumId`. Empty
   * `topicVotes` means the account has not voted this period on that instance.
   */
  async getAccountVotingRecord(
    account: string,
    instanceNumId: number | bigint,
    periodId: bigint | number,
  ): Promise<FracAccountVotingRecord> {
    const instanceNumIdArg = assertUint(instanceNumId, 16, 'instanceNumId')
    const periodIdArg = assertUint(periodId, 32, 'periodId')
    const { returns } = await this.readClient
      .newGroup()
      .getAccountVotingRecord({
        args: { account, instanceNumId: instanceNumIdArg, periodId: periodIdArg },
        staticFee: (2 * 1000).microAlgo(), // outer call + one inner call (instance getVotingRecord)
      })
      .simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /**
   * Drive one of the registry's paged per-instance log methods to completion. Each call logs the
   * account's total instance count first (a `uint16`), then one struct per instance covered by the
   * page; this reads the total, decodes the page, and advances `offset` by `pageSize` until the
   * whole instance list is covered. The high `staticFee` on each page (set by the caller) covers the
   * fee pool for the page's inner calls and is free under `allowEmptySignatures`.
   */
  private async _pageAccountInstanceLogs<T>(
    pageSize: number,
    buildPage: (limit: number, offset: number) => FracDelegationRegistryComposer<any>,
    structName: string,
  ): Promise<T[]> {
    const out: T[] = []
    let offset = 0
    let total = Infinity
    while (offset < total) {
      const { confirmations } = await buildPage(pageSize, offset).simulate(SIMULATE_PARAMS)
      const logs = confirmations.flatMap(({ logs }) => logs ?? [])
      // The method always logs the total count first; no logs at all would mean a malformed response.
      if (logs.length === 0) {
        throw new Error(`Malformed simulate response: missing logs for ${structName} page (offset=${offset})`)
      }
      total = Number(getABIDecodedValue(new Uint8Array(logs[0]!), 'uint16', CROSS_INSTANCE_STRUCTS))
      for (const log of logs.slice(1)) {
        out.push(getABIDecodedValue(new Uint8Array(log!), structName, CROSS_INSTANCE_STRUCTS) as T)
      }
      offset += Math.max(1, pageSize)
    }
    return out
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
