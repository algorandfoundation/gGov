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
} from '../generated/FracDelegationRegistryClient.js'
import { APP_SPEC as INSTANCE_APP_SPEC, FracAccountCommitteeAq } from '../generated/FracDelegationInstanceClient.js'
import type { FracInstanceCommitteeStanding } from '../generated/FracDelegationRegistryClient.js'
import { getConstructorConfig } from '../networkConfig.js'
import { ReaderConstructorArgs } from './types.js'
import { assertUint } from '../util/assertUint.js'
import { chunk } from '../util/chunk.js'
import { chunked } from '../util/chunked.js'
import { committeeIdToRaw } from '../util/comitteeId.js'
import { errorTransformer } from '../util/wrapErrors.js'
import { undefinedIfBoxMissing } from '../util/boxes.js'
import { SIMULATE_PARAMS } from 'sdk-shared'

/**
 * Max instances per page for the registry's paged cross-instance log methods. Each page is a single
 * readonly simulate app call, and simulate with `allowUnnamedResources` gives one app call a flat
 * pool of 128 unnamed resource references (boxes + foreign apps) — the AVM's 8-box/8-foreign-app
 * per-transaction array caps do not bind here, they are reported as unnamed resources instead. So a
 * page covers `floor((128 - fixed) / perInstance)` instances and longer instance lists span
 * successive pages.
 *
 * Fixed cost, both account-scoped methods: 1 reference — the caller's `accounts` box, read once by
 * `getAccountIfExists`.
 *
 * `logAccountInstanceAQ` — the only one with a second axis, since it reports on `C` committees per
 * instance. Per instance: the registry `instances` box and the instance app (its inner calls, which
 * double as the `app_params_get` existence probe) = 2. Per (instance, committee) pair: the 3 boxes
 * `getAccountCommitteeAq` reads on that instance (`committees`, `committeeAq`, `accountAq`) = 3C.
 * So a page of `I` instances over `C` committees costs
 *
 *     refs(I, C) = 1 + I·(2 + 3C) ≤ 128     =>     instancesPerPage(C) = floor(127 / (2 + 3C))
 *
 * C = 1 gives floor(127 / 5) = 25 — the single-committee page size this method had before it grew
 * the committee axis, and the `1 + 25×5 = 126` the extended spec measures. C = 41 is the widest
 * that still fits one instance (`1 + 1×125 = 126`); C = 42 fits none, which is why the committee
 * axis needs its own cap (`AQ_MAX_COMMITTEES_PER_CALL`) rather than only a page size.
 *
 * `logAccountVotingRecords` — 3 references per instance: the registry `instances` box, the instance
 * app (its inner call), and the 1 box `getVotingRecord` reads on that instance (`votingRecords`).
 * => floor((128 - 1) / 3) = 42.
 *
 * `logInstanceCommittees` — no fixed cost (it takes no account), and 4 references per instance: the
 * registry `instances` box, the instance app (its inner call, which doubles as the `app_params_get`
 * existence probe), and the 2 boxes `getCommitteeStanding` reads on that instance (`committees`,
 * `committeeAq`). => floor(128 / 4) = 32.
 */
const AQ_PAGE_SIZE = 25
const VOTING_RECORDS_PAGE_SIZE = 42
const INSTANCE_COMMITTEES_PAGE_SIZE = 32

/**
 * The reference pool one AQ page has left after its fixed cost — `128 - 1`, the caller's `accounts`
 * box. The numerator of `instancesPerPage(C)` above.
 */
const AQ_REF_BUDGET = 127

/**
 * Widest committee list one `logAccountInstanceAQ` call can carry: `floor((127 - 2) / 3) = 41`, the
 * point at which a single instance exhausts the budget. Also comfortably inside the 2,048-byte ABI
 * argument cap (41 × 32 + 2 = 1,314 bytes for the encoded array).
 */
const AQ_MAX_COMMITTEES_PER_CALL = 41

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
   *  Mutable so a caller can dial them down (or a test can force paging with few instances).
   *
   *  `aqPageSize` is an *upper bound* on instances per page, not the page size itself: the AQ
   *  reader sizes its two axes against each other, so the instances it actually puts in a page is
   *  `min(instanceCount, aqPageSize)` and the committee list is then sized to fit. It only binds
   *  when the committee list is short enough that instances are the scarce axis. */
  public aqPageSize = AQ_PAGE_SIZE
  public votingRecordsPageSize = VOTING_RECORDS_PAGE_SIZE
  public instanceCommitteesPageSize = INSTANCE_COMMITTEES_PAGE_SIZE

  /** Reference budget one AQ page may spend, and the widest committee list one call may carry (see
   *  `AQ_REF_BUDGET` / `AQ_MAX_COMMITTEES_PER_CALL`). Mutable for the same reason as the page sizes:
   *  a test dials them down to force chunking on either axis with only a handful of instances. */
  public aqRefBudget = AQ_REF_BUDGET
  public aqMaxCommitteesPerCall = AQ_MAX_COMMITTEES_PER_CALL

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
   * An account's AlgoQuarters standing in each of gGov committees `committeeIds` across every frac
   * instance it belongs to — one `FracAccountCommitteeAq` per (instance, committee) pair. Each entry
   * joins the instance's identity, the committee's local numeric ID, the account's weight (`userAq`)
   * against the committee total (`totalAq`), and the instance's gGov power there (`totalVotes`), so
   * a caller can price a position from this read alone.
   *
   * Returns a flat list rather than a map: every entry echoes its own `committeeId`, so callers
   * group by it and never index-align. Within one call rows come back instance-major (the account's
   * `instanceNumIds` order, then `committeeIds` order); across chunks the order of the committee
   * axis follows the chunking, so treat the aggregate as unordered on that axis.
   *
   * Drives the registry's paged `logAccountInstanceAQ`, whose reference cost grows on both axes
   * (`1 + I·(2 + 3C) ≤ 128`, see the page-size block at the top of this file). The two axes are
   * sized against each other rather than paging instances serially, because committee chunks are
   * independent and go out in parallel: instances per page is capped at the account's own instance
   * count (`opts.numInstances`, when the caller already knows it) and the committee list is then
   * chunked to whatever the remaining budget allows. Without the hint the committee list — always
   * known — is sized first and the instance axis takes the remainder, which for one committee is
   * the 25-instance page this reader has always used. See `_sizeAqAxes`.
   *
   * Empty if the account is not registered or `committeeIds` is empty; per pair, an unsynced
   * committee comes back with `committeeNumId`/`userAq`/`totalAq`/`totalVotes` 0, and an instance
   * whose app has been deleted is skipped on chain rather than taking the page down.
   *
   * @param opts.numInstances How many instances the account belongs to, if already known (e.g. from
   *   `getFracRegAccountsMap`). Only sizes the axes — a wrong value costs round-trips, not results.
   */
  async getAccountInstanceAQs(
    account: string,
    committeeIds: (Uint8Array | string)[],
    opts?: { numInstances?: number },
  ): Promise<FracAccountCommitteeAq[]> {
    const committeeIdsRaw = committeeIds.map(committeeIdToRaw)
    if (committeeIdsRaw.length === 0) return []

    const { instancesPerPage, committeesPerCall } = this._sizeAqAxes(committeeIdsRaw.length, opts?.numInstances)
    const chunks = chunk(committeeIdsRaw, committeesPerCall)

    const pages = await pMap(
      chunks,
      (committeeIdsChunk) =>
        this._pageInstanceLogs<FracAccountCommitteeAq>(
          instancesPerPage,
          (limit, offset) =>
            this.readClient.newGroup().logAccountInstanceAq({
              args: { account, committeeIds: committeeIdsChunk, limit, offset },
              // The outer call plus one inner call per (instance, committee) pair it covers.
              staticFee: ((limit * committeeIdsChunk.length + 1) * 1000).microAlgo(),
            }),
          'FracAccountCommitteeAq',
        ),
      { concurrency: this.concurrency },
    )
    return pages.flat()
  }

  /**
   * Split one AQ read's reference budget (`1 + I·(2 + 3C) ≤ 128`) between its two axes. Both
   * branches below satisfy that inequality; they differ in which axis is solved for.
   *
   * Sizing them against each other beats paging one serially, because the two axes cost differently:
   * instance pages are discovered (page 1 reports the total, so the rest go out in parallel behind
   * it) while committee chunks are known up front and all go out at once. So:
   *
   * - With a `numInstances` hint, the instance axis is solved first — capped at what the account
   *   actually has, since a page sized for more instances than exist just starves the committee axis
   *   into extra chunks — and the committee axis takes whatever budget is left.
   * - Without one, the committee axis is solved first (it is the caller's own list, so its size is
   *   always known) and the instance axis takes the remainder. `C = 1` lands on
   *   `floor(127 / 5) = 25`, the single-committee page size this reader has always used, so the
   *   uninformed path costs exactly what it did before the committee axis existed.
   *
   * `aqPageSize` bounds the instance axis in both branches, which is what lets a test dial it down
   * to force paging.
   */
  private _sizeAqAxes(
    numCommittees: number,
    numInstances?: number,
  ): { instancesPerPage: number; committeesPerCall: number } {
    const maxCommittees = Math.max(1, Math.min(numCommittees, this.aqMaxCommitteesPerCall))

    if (numInstances && numInstances > 0) {
      const instancesPerPage = Math.min(numInstances, this.aqPageSize)
      const perInstanceBudget = this.aqRefBudget / instancesPerPage
      const committeesPerCall = Math.min(Math.max(Math.floor((perInstanceBudget - 2) / 3), 1), maxCommittees)
      return { instancesPerPage, committeesPerCall }
    }

    const committeesPerCall = maxCommittees
    const instancesPerPage = Math.max(
      1,
      Math.min(this.aqPageSize, Math.floor(this.aqRefBudget / (2 + 3 * committeesPerCall))),
    )
    return { instancesPerPage, committeesPerCall }
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
    return this._pageInstanceLogs<FracAccountVotingRecord>(
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
   * total instance count first (a `uint16`) — the account's instance list for the account-scoped
   * methods, the registry's whole instance range for `logInstanceCommittees` — then one struct per
   * instance covered by the page; this reads the total, decodes the page, and advances `offset` by
   * `pageSize` until the whole range is covered. The high `staticFee` on each page (set by the
   * caller) covers the fee pool for the page's inner calls and is free under `allowEmptySignatures`.
   *
   * A page may log fewer records than it covers instances (`logInstanceCommittees` skips instances
   * whose app is gone), so paging is driven by `offset`/`total` rather than by how many records came
   * back.
   *
   * Only the first page is serial. It reports the total, which fixes every remaining offset up
   * front, so pages 2..n go out concurrently at `this.concurrency` — pages are independent readonly
   * simulates and nothing after the first depends on what the others return. Results are
   * concatenated in offset order, so the aggregate stays in the on-chain enumeration order callers
   * rely on.
   */
  private async _pageInstanceLogs<T>(
    pageSize: number,
    buildPage: (limit: number, offset: number) => FracDelegationRegistryComposer<any>,
    structName: string,
  ): Promise<T[]> {
    const limit = Math.max(1, pageSize)

    const readPage = async (offset: number): Promise<{ total: number; rows: T[] }> => {
      const { confirmations } = await buildPage(limit, offset).simulate(SIMULATE_PARAMS)
      const logs = confirmations.flatMap(({ logs }) => logs ?? [])
      // The method always logs the total count first; no logs at all would mean a malformed response.
      if (logs.length === 0) {
        throw new Error(`Malformed simulate response: missing logs for ${structName} page (offset=${offset})`)
      }
      const total = Number(getABIDecodedValue(new Uint8Array(logs[0]!), 'uint16', CROSS_INSTANCE_STRUCTS))
      const rows = logs
        .slice(1)
        .map((log) => getABIDecodedValue(new Uint8Array(log!), structName, CROSS_INSTANCE_STRUCTS) as T)
      return { total, rows }
    }

    const first = await readPage(0)
    if (first.total <= limit) return first.rows

    const offsets: number[] = []
    for (let offset = limit; offset < first.total; offset += limit) offsets.push(offset)
    const rest = await pMap(offsets, (offset) => readPage(offset), { concurrency: this.concurrency })
    return [...first.rows, ...rest.flatMap(({ rows }) => rows)]
  }

  // ── Instances ────────────────────────────────────────────────────

  /**
   * Every registered instance's standing in gGov committee `committeeId` — one
   * `FracInstanceCommitteeStanding` per live instance, ascending by numeric ID, joining the
   * instance's identity with its synced `totalVotes` and the AlgoQuarters ledger behind it.
   *
   * The one-call answer to "which pools hold power in this committee, and how much stake is behind
   * it". The alternative it replaces is `getExistingInstances()` — a box-map read plus one algod
   * lookup per instance — followed by `getCommittees` and `getCommitteeAq` per instance: roughly
   * `3N + 1` round-trips against this method's `ceil(N / instanceCommitteesPageSize)`.
   *
   * Instances whose app has been deleted are dropped on chain (they cannot be inner-called), which
   * is what makes the SDK-side existence filter unnecessary. An instance that never synced the
   * committee is *not* dropped: it comes back with `committeeNumId` 0 and zeroed figures, so callers
   * can distinguish "synced, holds nothing" from "never synced". Filter on `totalVotes > 0` for
   * pools that actually carry weight here.
   *
   * Paged like the account-scoped log readers: the page size is bounded by the simulate
   * unnamed-reference budget (`instanceCommitteesPageSize`), and a long instance list spans several
   * simulate round-trips.
   */
  async getInstanceCommitteeStandings(committeeId: Uint8Array | string): Promise<FracInstanceCommitteeStanding[]> {
    const committeeIdRaw = committeeIdToRaw(committeeId)
    return this._pageInstanceLogs<FracInstanceCommitteeStanding>(
      this.instanceCommitteesPageSize,
      (limit, offset) =>
        this.readClient.newGroup().logInstanceCommittees({
          args: { committeeId: committeeIdRaw, limit, offset },
          staticFee: ((limit + 1) * 1000).microAlgo(),
        }),
      'FracInstanceCommitteeStanding',
    )
  }

  /**
   * One instance's standing in gGov committee `committeeId`, tagged with its identity — the
   * singular counterpart of {@link getInstanceCommitteeStandings}, for a known `instanceNumId` and
   * with no paging. Throws if the instance is not registered, and (unlike the paged reader, which
   * skips them) if its app has been deleted.
   */
  async getInstanceCommittee(
    instanceNumId: number | bigint,
    committeeId: Uint8Array | string,
  ): Promise<FracInstanceCommitteeStanding> {
    const instanceNumIdArg = assertUint(instanceNumId, 16, 'instanceNumId')
    const committeeIdRaw = committeeIdToRaw(committeeId)
    const { returns } = await this.readClient
      .newGroup()
      .getInstanceCommittee({
        args: { instanceNumId: instanceNumIdArg, committeeId: committeeIdRaw },
        staticFee: (2 * 1000).microAlgo(), // outer call + one inner call (instance getCommitteeStanding)
      })
      .simulate(SIMULATE_PARAMS)
    return returns[0]!
  }

  /**
   * All recorded instances, keyed by `instanceNumId`. The `instances` box entry is never removed
   * once created (the contract has no on-chain instance-removal path), so this may include
   * entries for instance apps that have been deleted.
   */
  async getInstances(): Promise<Map<number, FracInstance>> {
    // TODO simulate plural logger to get instances in pages
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
