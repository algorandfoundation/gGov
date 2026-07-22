import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getABIDecodedValue } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { ALGORAND_ZERO_ADDRESS_STRING, encodeAddress, makeEmptyTransactionSigner } from 'algosdk'
import pMap from 'p-map'
import {
  CommitteeMetadata,
  GGovRegistryClient,
  GGovRegistryComposer,
  GGovAccount,
  SuperboxMeta,
  GGovPeriodSummary,
  APP_SPEC,
} from '../generated/GGovRegistryClient'
import { getConstructorConfig } from '../networkConfig'
import {
  CommitteeId,
  AccountWithVotes,
  ReaderConstructorArgs,
  STORED_GOV_BYTE_LENGTH,
  StoredGov,
  GGovCommitteeFile,
} from './types'
import { assertUint } from '../util/assertUint'
import { chunk } from '../util/chunk'
import { chunked } from '../util/chunked'
import { committeeIdToRaw } from '../util/comitteeId'
import { errorTransformer, wrapErrors } from '../util/wrapErrors'
import { SIMULATE_PARAMS } from '../util/increaseBudget'

/** A registry period summary paired with its periodId. */
export interface PeriodSummaryWithId {
  id: bigint
  summary: GGovPeriodSummary
}

const PARTIAL_COMMITTEE_SIMULATE_CALLS = 16 // 16 simulate calls per fast-get
const PARTIAL_COMMITTEE_FIRST_DATA_PAGE_LENGTH = 6 // first fast-get call retrieves 6 data pages, because 2x refs needed for sb meta + committee meta
const PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH = 7 // subsequent calls retrieve 7 data pages, because 1x ref needed for sb meta

export class GGovRegistryReaderSDK {
  static APP_SPEC = APP_SPEC

  public algorand: AlgorandClient
  public appId: bigint
  public readClient: GGovRegistryClient
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
    this.readClient = new GGovRegistryClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    })
  }

  /**
   * Get committee the reasonable way, fetching metadata, then superbox metadata, then govs sequentially
   * @param committeeId
   * @returns
   */
  @wrapErrors()
  async getCommittee(committeeId: CommitteeId): Promise<GGovCommitteeFile | null> {
    const committeeMetadata = await this.getCommitteeMetadata(committeeId, true)
    if (!committeeMetadata) return null
    const govs = await this.getCommitteeGovs(committeeId)
    const params = await this.algorand.getSuggestedParams()
    const networkGenesisHash = Buffer.from(params.genesisHash!).toString('base64')
    // TODO validate committee ID
    return {
      networkGenesisHash,
      periodEnd: committeeMetadata.periodEnd,
      periodStart: committeeMetadata.periodStart,
      registryId: Number(committeeMetadata.xGovRegistryId),
      totalMembers: committeeMetadata.totalMembers,
      totalVotes: committeeMetadata.totalVotes,
      govs: govs.map(({ account, votes }) => ({ address: account.toString(), votes })),
    }
  }

  /**
   * Get committee with parallel calls and simulate heroics
   * @param committeeId
   * @returns
   */
  @wrapErrors()
  async fastGetCommittee(
    committeeId: CommitteeId,
    { includeBoxOrder }: { includeBoxOrder?: boolean } = {},
  ): Promise<(GGovCommitteeFile & { govBoxOrder?: string[] }) | null> {
    const firstPartialCommitteeDataPromise = this.fastGetPartialCommitteeData(committeeId, 0)
    const accountIdMapPromise = this.getAccountIdMap()

    const { committeeMetadata, storedGovs, lastDataPage, totalDataPages } = await firstPartialCommitteeDataPromise
    // fetch rest if needed
    // 6 + 15 * 7 = 111 data boxes on first fastGet call, 2048 sized boxes, 227328 bytes total, 8 bytes per gov: 28416 govs needed to require a second fastGet page
    const nextDataPage = lastDataPage + 1
    if (nextDataPage < totalDataPages) {
      const partialFetchDataSize = PARTIAL_COMMITTEE_SIMULATE_CALLS * PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH
      const extraCalls = Math.ceil((totalDataPages! - nextDataPage) / partialFetchDataSize)
      const arr = Array.from({ length: extraCalls }, (_, i) => nextDataPage + i * partialFetchDataSize)
      await pMap(
        arr,
        (pageStart) =>
          this.fastGetPartialCommitteeData(committeeId, pageStart).then((data) => storedGovs.push(...data.storedGovs)),
        { concurrency: this.concurrency },
      )
    }

    const accountIdMap = await accountIdMapPromise
    const boxOrderedGovs = this.convertStoredGovsToGovs(storedGovs, accountIdMap)
    const govs = [...boxOrderedGovs].sort(this.sortGovs)

    const params = await this.algorand.getSuggestedParams()
    const networkGenesisHash = Buffer.from(params.genesisHash!).toString('base64')
    // TODO validate committee ID

    return {
      networkGenesisHash,
      periodEnd: committeeMetadata.periodEnd,
      periodStart: committeeMetadata.periodStart,
      registryId: Number(committeeMetadata.xGovRegistryId),
      totalMembers: committeeMetadata.totalMembers,
      totalVotes: committeeMetadata.totalVotes,
      govs: govs
        .map(({ account, votes }) => ({ address: account.toString(), votes }))
        .sort((a, b) => (a.address < b.address ? -1 : 1)),
      ...(includeBoxOrder ? { govBoxOrder: boxOrderedGovs.map(({ account }) => account.toString()) } : {}),
    }
  }

  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: 0,
  ): Promise<{
    committeeMetadata: CommitteeMetadata
    storedGovs: StoredGov[]
    lastDataPage: number
    totalDataPages: number
  }>
  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: number,
  ): Promise<{ storedGovs: StoredGov[]; lastDataPage: number }>
  async fastGetPartialCommitteeData(
    committeeId: CommitteeId,
    startDataPage: number,
  ): Promise<{
    committeeMetadata?: CommitteeMetadata
    storedGovs: StoredGov[]
    lastDataPage: number
    totalDataPages?: number
  }> {
    const returnMetadata = startDataPage === 0
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup()

    for (let i = 0; i < PARTIAL_COMMITTEE_SIMULATE_CALLS; i++) {
      const logMetadata = returnMetadata && i === 0
      const dataPageLength = logMetadata
        ? PARTIAL_COMMITTEE_FIRST_DATA_PAGE_LENGTH
        : PARTIAL_COMMITTEE_SECOND_DATA_PAGE_LENGTH
      builder = builder.logCommitteePages({
        args: {
          committeeId: committeeIdToRaw(committeeId),
          logMetadata: returnMetadata && i === 0,
          startDataPage,
          dataPageLength,
        },
      })
      startDataPage += dataPageLength
    }

    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs)
    let committeeMetadata: CommitteeMetadata | undefined
    let superboxMeta: SuperboxMeta | undefined
    let storedGovs: StoredGov[] = []

    let ptr = 0
    if (returnMetadata) {
      committeeMetadata = getABIDecodedValue(
        new Uint8Array(logs[ptr++]!),
        'CommitteeMetadata',
        this.readClient.appSpec.structs,
      ) as CommitteeMetadata
      superboxMeta = getABIDecodedValue(
        new Uint8Array(logs[ptr++]!),
        'SuperboxMeta',
        this.readClient.appSpec.structs,
      ) as SuperboxMeta
    }
    for (let i = ptr; i < logs.length; i++) {
      const logValue = new Uint8Array(logs[i]!)
      if (logValue.length > 0) {
        const pageGovs = this.convertSuperboxToStoredGovs(logValue)
        storedGovs = storedGovs.concat(pageGovs)
      } else {
        break // reached end of data pages
      }
    }
    return {
      committeeMetadata,
      storedGovs,
      lastDataPage: startDataPage - 1,
      totalDataPages: superboxMeta ? superboxMeta.boxByteLengths.length : undefined,
    }
  }

  async getCommitteeGovs(committeeId: CommitteeId): Promise<AccountWithVotes[]> {
    const [storedGovs, accountMap] = await Promise.all([
      this.getCommitteeSuperboxData(committeeId),
      this.getAccountIdMap(),
    ])
    return this.convertStoredGovsToGovs(storedGovs, accountMap).sort(this.sortGovs)
  }

  protected convertStoredGovsToGovs(storedGovs: StoredGov[], accountMap: Map<string, number>): AccountWithVotes[] {
    const idToAddress = new Map<number, string>()
    for (const [address, accountId] of accountMap) {
      idToAddress.set(accountId, address)
    }
    return storedGovs.map(([id, votes]) => ({
      accountId: id,
      account: idToAddress.get(id) ?? ALGORAND_ZERO_ADDRESS_STRING,
      votes,
    }))
  }

  protected sortGovs(a: AccountWithVotes, b: AccountWithVotes): number {
    return a.account < b.account ? -1 : 1
  }

  async getAdmin(): Promise<string> {
    const admin = await this.readClient.state.global.admin()
    return admin!
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

  async getCommitteeMetadata(
    committeeId: CommitteeId,
    mustBeComplete: boolean = false,
  ): Promise<CommitteeMetadata | null> {
    const { return: committeeMetadata } = await this.readClient.send.getCommitteeMetadata({
      args: { committeeId: committeeIdToRaw(committeeId), mustBeComplete },
    })
    if (committeeMetadata!.periodEnd === 0) return null
    return committeeMetadata!
  }

  /**
   * Batch-fetch metadata for many committees in a single (chunked) simulate group via `logCommitteeMetadata`.
   * The result is index-aligned with `committeeIds`; non-existent committees (periodEnd === 0) come back as null.
   */
  async getCommitteesMetadata(committeeIds: CommitteeId[]): Promise<(CommitteeMetadata | null)[]> {
    return this._getCommitteesMetadataChunked(committeeIds.map((id) => committeeIdToRaw(id)))
  }

  @chunked(126)
  private async _getCommitteesMetadataChunked(committeeIds: Uint8Array[]): Promise<(CommitteeMetadata | null)[]> {
    if (committeeIds.length === 0) return []
    const committeeIdChunks = chunk(committeeIds, 63)
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup()
    for (const committeeIdChunk of committeeIdChunks) {
      builder = builder.logCommitteeMetadata({ args: { committeeIds: committeeIdChunk } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map((log) => {
      const meta = getABIDecodedValue(
        new Uint8Array(log!),
        'CommitteeMetadata',
        this.readClient.appSpec.structs,
      ) as CommitteeMetadata
      return meta.periodEnd === 0 ? null : meta
    })
  }

  /**
   * Batch-read an account's gov voting power across many committees in a single (chunked) simulate group.
   * The result is index-aligned with `committeeIds`. There is no batch ABI method, so each committee is one
   * readonly call grouped into the simulate (chunked to stay under the 16-txn group limit).
   *
   * Uses the non-throwing `tryGetGovVotingPower` (returns 0 for committees the account is not a member of) —
   * the throwing `getGovVotingPower` would fail the entire simulate group on the first non-member committee.
   */
  async getGovVotingPowers(committeeIds: CommitteeId[], account: string): Promise<number[]> {
    return this._getGovVotingPowersChunked(
      committeeIds.map((id) => committeeIdToRaw(id)),
      account,
    )
  }

  @chunked(16)
  private async _getGovVotingPowersChunked(committeeIds: Uint8Array[], account: string): Promise<number[]> {
    if (committeeIds.length === 0) return []
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup()
    for (const committeeId of committeeIds) {
      builder = builder.tryGetGovVotingPower({ args: { committeeId, account } })
    }
    const { returns } = await builder.simulate(SIMULATE_PARAMS)
    return (returns ?? []).map((power: unknown) => Number(power ?? 0))
  }

  async getCommitteeSuperboxMeta(committeeId: CommitteeId): Promise<SuperboxMeta> {
    const { return: superboxMeta } = await this.readClient.send.getCommitteeSuperboxMeta({
      args: { committeeId: committeeIdToRaw(committeeId) },
    })
    return superboxMeta!
  }

  async getCommitteeSuperboxData(committeeId: CommitteeId): Promise<StoredGov[]> {
    const [meta, commmitteeMetadata] = await Promise.all([
      this.getCommitteeSuperboxMeta(committeeId),
      this.getCommitteeMetadata(committeeId),
    ])
    const numPages = Math.ceil(Number(meta.totalByteLength) / Number(meta.maxBoxSize))
    const pages = Array.from({ length: numPages }, (_, i) => i)
    const pageData = await pMap(
      pages,
      (page) => this.getSuperboxAsStoredGovs(this.getCommitteeSuperboxPageKey(commmitteeMetadata!, page)),
      {
        concurrency: this.concurrency,
      },
    )
    return pageData.flat()
  }

  getCommitteeSuperboxPrefix(committeeMetadata: CommitteeMetadata): string {
    return `S${committeeMetadata.numericId}`
  }

  getCommitteeSuperboxPageKey(committeeMetadata: CommitteeMetadata, page: number): string {
    // superbox@2.0.0 delimits the prefix from the page index with `_` (data box name = `name + '_' + page`)
    return `${this.getCommitteeSuperboxPrefix(committeeMetadata)}_${page}`
  }

  async getCommitteeSuperboxDataLast(committeeId: CommitteeId): Promise<{ last?: StoredGov; total: number }> {
    const [meta, commmitteeMetadata] = await Promise.all([
      this.getCommitteeSuperboxMeta(committeeId),
      this.getCommitteeMetadata(committeeId),
    ])
    const numGovs = Math.ceil(Number(meta.totalByteLength) / Number(meta.valueSize))
    if (numGovs === 0) {
      return { total: 0 }
    }
    const numPages = Math.ceil(Number(meta.totalByteLength) / Number(meta.maxBoxSize))
    const superboxKey = this.getCommitteeSuperboxPageKey(commmitteeMetadata!, numPages - 1)
    const lastPage = await this.getSuperboxAsStoredGovs(superboxKey)
    return { last: lastPage[lastPage.length - 1], total: numGovs }
  }

  protected async getSuperboxAsStoredGovs(superboxKey: string): Promise<StoredGov[]> {
    return this.convertSuperboxToStoredGovs(await this.algorand.app.getBoxValue(this.appId, superboxKey))
  }

  protected convertSuperboxToStoredGovs(arr: Uint8Array): StoredGov[] {
    const chunks = chunk(Array.from(arr), STORED_GOV_BYTE_LENGTH) // each StoredGov is (uint32, uint32)
    return chunks.map((c) => getABIDecodedValue(new Uint8Array(c), '(uint32,uint32)', {}) as StoredGov)
  }

  async getAccounts(): Promise<string[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId)
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 97 && nameRaw.length === 33)
      .map(({ nameRaw }) => {
        return encodeAddress(nameRaw.slice(1)).toString()
      })
  }

  async getAccountIdMap(accounts?: string[]): Promise<Map<string, number>> {
    accounts = accounts ?? (await this.getAccounts())
    const gGovAccounts = await this._getGGovAccountsChunked(accounts)
    return new Map(accounts.map((account, index) => [account, gGovAccounts[index].accountId]))
  }

  async getGGovAccountsMap(accounts?: string[]): Promise<Map<string, GGovAccount>> {
    accounts = accounts ?? (await this.getAccounts())
    const gGovAccounts = await this._getGGovAccountsChunked(accounts)
    return new Map(accounts.map((account, index) => [account, gGovAccounts[index]]))
  }

  @chunked(126)
  private async _getGGovAccountsChunked(accounts: string[]): Promise<GGovAccount[]> {
    if (accounts.length === 0) return []
    const accountArgs = chunk(accounts, 63)
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup()
    for (const accountChunk of accountArgs) {
      builder = builder.logAccounts({ args: { accounts: accountChunk } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map(
      (log) => getABIDecodedValue(new Uint8Array(log!), 'GGovAccount', this.readClient.appSpec.structs) as GGovAccount,
    )
  }

  // ── Period summaries (registry-stored) ───────────────────────────

  /** Fetch per-period summaries (appId, votingStart, votingEnd, numTopics) in one round trip. */
  @chunked(128)
  @wrapErrors()
  async getPeriodSummaries(periodIds: bigint[]): Promise<GGovPeriodSummary[]> {
    if (periodIds.length === 0) return []
    // `@chunked` runs this per 128-id chunk, so validate without a (chunk-local, misleading) index.
    periodIds.forEach((periodId) => assertUint(periodId, 64, 'periodId'))
    const builder = this.readClient.newGroup().logPeriodSummaries({ args: { periodIds } })
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map(
      (log) =>
        getABIDecodedValue(
          new Uint8Array(log!),
          'GGovPeriodSummary',
          this.readClient.appSpec.structs,
        ) as GGovPeriodSummary,
    )
  }

  /**
   * All live period summaries on the registry, paired with their periodId.
   * Enumerates 1..lastPeriodId and filters out deleted periods (summary.appId === 0).
   */
  @wrapErrors()
  async getAllPeriodSummaries(): Promise<PeriodSummaryWithId[]> {
    // TODO change to use firstPeriodId to lastPeriodId, rather than assuming 1..lastPeriodId
    const { lastPeriodId } = await this.getGlobalState()
    const count = Number(lastPeriodId ?? 0)
    if (count === 0) return []
    const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1))
    const summaries = await this.getPeriodSummaries(ids)
    return ids
      .map((id, i) => ({ id, summary: summaries[i] }))
      .filter(({ summary }) => summary && BigInt(summary.appId) !== 0n)
  }

  // ── Delegations ──────────────────────────────────────────────────

  @wrapErrors()
  async getDelegation(account: string): Promise<{ delegatee: string; exists: boolean }> {
    const { return: result } = await this.readClient.send.getDelegation({ args: { account } })
    return { delegatee: result![0], exists: result![1] }
  }

  /** Reverse lookup: addresses that have delegated to `delegatee` (empty if none), one per log line. */
  @wrapErrors()
  async getDelegators(delegatee: string): Promise<string[]> {
    const builder = this.readClient.newGroup().logDelegators({ args: { delegatee } })
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    // A confirmation with no logs surfaces as an undefined `logs` field — coalesce so the empty
    // reverse list (box deleted) yields [] rather than a single undefined entry.
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map(
      (log) => getABIDecodedValue(new Uint8Array(log!), 'address', this.readClient.appSpec.structs) as string,
    )
  }

  @chunked(126)
  @wrapErrors()
  async getDelegations(accounts: string[]): Promise<string[]> {
    if (accounts.length === 0) return []
    const accountChunks = chunk(accounts, 63)
    let builder: GGovRegistryComposer<any> = this.readClient.newGroup()
    for (const accountChunk of accountChunks) {
      builder = builder.logDelegations({ args: { accounts: accountChunk } })
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS)
    const logs = confirmations.flatMap(({ logs }) => logs ?? [])
    return logs.map(
      (log) => getABIDecodedValue(new Uint8Array(log!), 'address', this.readClient.appSpec.structs) as string,
    )
  }

  /** Get all delegations by scanning delegation box keys and batch-fetching delegatees. */
  async getAllDelegations(): Promise<Map<string, string>> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId)
    const accounts = boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 0x64 && nameRaw.length === 33) // 'd' prefix + 32-byte address
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(1)).toString())
    if (accounts.length === 0) return new Map()
    const delegatees = await this.getDelegations(accounts)
    return new Map(accounts.map((account, i) => [account, delegatees[i]]))
  }

  /** List committee IDs registered on the registry (box-name scan). */
  async getCommitteeIds(): Promise<Uint8Array[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId)
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 99 && nameRaw.length === 33) // 'c' prefix
      .map(({ nameRaw }) => nameRaw.slice(1))
  }
}
