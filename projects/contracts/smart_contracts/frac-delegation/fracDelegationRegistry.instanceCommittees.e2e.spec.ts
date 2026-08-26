import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount } from 'algosdk'
import { AlgoQuartersFile } from 'frac-delegation-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { errInstanceAppNotExists } from '../base/errors.algo'
import { deployFracInstance, deployFracRegistry, deployRegistryWithCommittee, transformedError } from '../common-tests'
import { configureTestLogging } from '../test-utils'

/**
 * `logInstanceCommittees` / `getInstanceCommittee` — the registry's cross-instance view of one gGov
 * committee, and the `getCommitteeStanding` join on the instance that feeds it.
 *
 * The transpose of the `logAccountInstanceAQ` coverage next door: instead of one account across its
 * instances, this is every instance against one committee. What the tests pin down is that the
 * three states an instance can be in are all distinguishable from the log — synced with a ledger,
 * synced without one, never synced — and that a deleted instance app drops out instead of taking
 * the page down with it.
 */

/** Fresh, unfunded addresses. AQ rows are plain ARC-4 `address` values; they never sign. */
const freshAccounts = (n: number) => Array.from({ length: n }, () => generateAccount().addr.toString())

/** Manifest-shaped AQ file over `[address, aq]` rows, with LocalNet's genesis hash. */
const makeAqFile = async (localnet: AlgorandFixture, accountAqs: [string, number][]): Promise<AlgoQuartersFile> => {
  const sp = await localnet.algorand.getSuggestedParams()
  return {
    networkGenesisHash: Buffer.from(sp.genesisHash!).toString('base64'),
    protocol: 'reti',
    periodStart: 1_000_000,
    periodEnd: 2_000_000,
    totalAccounts: accountAqs.length,
    totalAlgoQuarters: accountAqs.reduce((sum, [, aq]) => sum + aq, 0).toString(),
    accounts: accountAqs.map(([account, aq]) => ({ account, algoQuarters: aq.toString() })),
  }
}

/**
 * One gGov committee of 4 govs (10 votes each), and one frac registry carrying three instances that
 * between them cover every state the logger has to report:
 *
 * - `withLedger`  — two escrows synced (20 votes), AQ ledger opened *and* ingested.
 * - `syncedOnly`  — one escrow synced (10 votes), no `startAqIngest` — so `totalAq` stays 0.
 * - `unsynced`    — registered with the registry but never `syncCommittee`'d.
 */
const setup = async (localnet: AlgorandFixture) => {
  const { testAccount } = localnet.context
  const { sdk: ggovSdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet, 4, 10)

  const withLedger = await deployFracInstance(localnet, testAccount, { name: 'pool-with-ledger' })
  const registrySdk = withLedger.sdk.registry
  await registrySdk.setGGovRegistryApp({ appId: ggovSdk.appId })

  const syncedOnly = await deployFracInstance(localnet, testAccount, { name: 'pool-synced-only', registrySdk })
  const unsynced = await deployFracInstance(localnet, testAccount, { name: 'pool-unsynced', registrySdk })

  // withLedger holds two of the committee's govs, syncedOnly holds one. An escrow is globally
  // unique across instances, so the sets cannot overlap.
  for (const account of [govAccounts[0].toString(), govAccounts[1].toString()]) {
    await registrySdk.registerEscrow({ instanceNumId: withLedger.instanceId, account })
  }
  await registrySdk.registerEscrow({ instanceNumId: syncedOnly.instanceId, account: govAccounts[2].toString() })

  await withLedger.sdk.syncCommittee({ instanceNumId: withLedger.instanceId, committeeId })
  await syncedOnly.sdk.syncCommittee({ instanceNumId: syncedOnly.instanceId, committeeId })

  // Ingest an AQ ledger on `withLedger` only: 3 accounts, 100 AQ each.
  const aqAccounts = freshAccounts(3)
  const aqFile = await makeAqFile(
    localnet,
    aqAccounts.map((a) => [a, 100] as [string, number]),
  )
  await withLedger.sdk.uploadAqFile({ instanceNumId: withLedger.instanceId, committeeId, aqFile })

  return { testAccount, committeeId, govAccounts, registrySdk, withLedger, syncedOnly, unsynced, aqAccounts }
}

/** Index a standings array by instance numeric id, for readable per-instance assertions. */
const byInstance = <T extends { instanceNumId: number }>(standings: T[]) =>
  new Map(standings.map((s) => [s.instanceNumId, s]))

describe('FracDelegationRegistry instance committees', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('getInstanceCommitteeStandings', () => {
    test('reports every instance, joining its identity with its snapshot and AQ ledger', async () => {
      const { committeeId, registrySdk, withLedger, syncedOnly, unsynced } = await setup(localnet)

      const standings = await registrySdk.getInstanceCommitteeStandings(committeeId)

      expect(standings).toHaveLength(3)
      // Ascending by numeric id — the order the registry enumerates them in.
      expect(standings.map((s) => s.instanceNumId)).toEqual([
        Number(withLedger.instanceId),
        Number(syncedOnly.instanceId),
        Number(unsynced.instanceId),
      ])

      const found = byInstance(standings)

      const a = found.get(Number(withLedger.instanceId))!
      expect(a.instanceName).toBe('pool-with-ledger')
      expect(a.instanceAppId).toBe(withLedger.appId)
      expect(a.committeeNumId).toBe(1)
      expect(a.totalVotes).toBe(20)
      expect(a.totalAq).toBe(300)
      expect(a.ingestedAq).toBe(300)
      expect(a.totalAccounts).toBe(3)
      expect(a.numAccounts).toBe(3)

      const b = found.get(Number(syncedOnly.instanceId))!
      expect(b.instanceName).toBe('pool-synced-only')
      expect(b.totalVotes).toBe(10)
      // Synced with no ledger open is its own state: a real committee, `totalAq` 0.
      expect(b.committeeNumId).toBe(1)
      expect(b.totalAq).toBe(0)
      expect(b.numAccounts).toBe(0)

      const c = found.get(Number(unsynced.instanceId))!
      expect(c.instanceName).toBe('pool-unsynced')
      // Never synced — reported rather than dropped, so a caller can tell it apart from absent.
      expect(c.committeeNumId).toBe(0)
      expect(c.totalVotes).toBe(0)
      expect(c.totalAq).toBe(0)
    })

    test('instanceNumAccounts is the registry-wide roster, not the committee window', async () => {
      const { committeeId, registrySdk, withLedger, aqAccounts } = await setup(localnet)

      // Ingesting AQ registers each account against the instance, so the roster and the
      // window-scoped count agree so far.
      let a = byInstance(await registrySdk.getInstanceCommitteeStandings(committeeId)).get(
        Number(withLedger.instanceId),
      )!
      expect(a.instanceNumAccounts).toBe(BigInt(aqAccounts.length))
      expect(a.numAccounts).toBe(aqAccounts.length)

      // Register one more account against the instance without giving it AQ in this committee.
      await registrySdk.writeClient!.send.getOrCreateAccountWithInstance({
        args: { account: freshAccounts(1)[0], instanceNumId: withLedger.instanceId },
      })

      a = byInstance(await registrySdk.getInstanceCommitteeStandings(committeeId)).get(Number(withLedger.instanceId))!
      // The roster grew; who actually held stake during the window did not.
      expect(a.instanceNumAccounts).toBe(BigInt(aqAccounts.length + 1))
      expect(a.numAccounts).toBe(aqAccounts.length)
    })

    test('skips an instance whose app has been deleted instead of failing the page', async () => {
      const { committeeId, registrySdk, withLedger, syncedOnly, unsynced } = await setup(localnet)

      await syncedOnly.sdk.deleteInstanceApp({ instanceNumId: syncedOnly.instanceId })
      await expect(localnet.algorand.app.getById(syncedOnly.appId)).rejects.toThrow()

      const standings = await registrySdk.getInstanceCommitteeStandings(committeeId)

      // The `instances` box survives the app, so the id is still in the range being paged — the
      // record is dropped because the app itself is gone.
      expect(standings.map((s) => s.instanceNumId)).toEqual([
        Number(withLedger.instanceId),
        Number(unsynced.instanceId),
      ])
      expect(byInstance(standings).get(Number(withLedger.instanceId))!.totalVotes).toBe(20)
    })

    test('pages over the instance range, returning the same set as a single page', async () => {
      const { committeeId, registrySdk } = await setup(localnet)

      const single = await registrySdk.getInstanceCommitteeStandings(committeeId)

      // One instance per page forces three round-trips over the same three instances.
      registrySdk.instanceCommitteesPageSize = 1
      const paged = await registrySdk.getInstanceCommitteeStandings(committeeId)

      expect(paged).toEqual(single)
      expect(paged).toHaveLength(3)
    })

    test('returns nothing for a committee no instance has synced', async () => {
      const { registrySdk } = await setup(localnet)

      const standings = await registrySdk.getInstanceCommitteeStandings(new Uint8Array(32).fill(7))

      // Every instance still reports — with the unsynced sentinel, which is the point.
      expect(standings).toHaveLength(3)
      expect(standings.every((s) => s.committeeNumId === 0 && s.totalVotes === 0)).toBe(true)
    })

    test('is empty on a registry that has never spawned an instance', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)

      // `lastInstanceNumId` is 0, so the logger emits the count and nothing else — the paging loop
      // has to terminate on that rather than spin.
      expect(await sdk.getInstanceCommitteeStandings(new Uint8Array(32).fill(3))).toEqual([])
    })
  })

  describe('getInstanceCommittee (singular)', () => {
    test('matches the record the paged reader logs for the same instance', async () => {
      const { committeeId, registrySdk, withLedger } = await setup(localnet)

      const one = await registrySdk.getInstanceCommittee(withLedger.instanceId, committeeId)
      const fromPage = byInstance(await registrySdk.getInstanceCommitteeStandings(committeeId)).get(
        Number(withLedger.instanceId),
      )!

      expect(one).toEqual(fromPage)
    })

    test('throws for an instance the registry does not know', async () => {
      const { committeeId, registrySdk } = await setup(localnet)

      await expect(registrySdk.getInstanceCommittee(999, committeeId)).rejects.toThrow(
        transformedError(errInstanceAppNotExists),
      )
    })
  })

  describe('getCommitteeStanding (instance)', () => {
    test('joins the snapshot and the ledger without the caller resolving committeeNumId', async () => {
      const { committeeId, withLedger } = await setup(localnet)

      const standing = (await withLedger.sdk.getCommitteeStanding(withLedger.instanceId, committeeId))!

      const committee = (await withLedger.sdk.getCommittee(withLedger.instanceId, committeeId))!
      const aq = (await withLedger.sdk.getCommitteeAq(withLedger.instanceId, committee.committeeNumId))!
      expect(standing.committeeNumId).toBe(committee.committeeNumId)
      expect(standing.totalVotes).toBe(committee.totalVotes)
      expect(standing.totalAq).toBe(aq.totalAq)
      expect(standing.ingestedAq).toBe(aq.ingestedAq)
      expect(standing.totalAccounts).toBe(aq.totalAccounts)
      expect(standing.numAccounts).toBe(aq.numAccounts)
    })

    test('is undefined for a committee the instance never synced', async () => {
      const { committeeId, unsynced } = await setup(localnet)

      expect(await unsynced.sdk.getCommitteeStanding(unsynced.instanceId, committeeId)).toBeUndefined()
    })

    test('reports a synced committee with no ledger as totalAq 0, not as unsynced', async () => {
      const { committeeId, syncedOnly } = await setup(localnet)

      const standing = (await syncedOnly.sdk.getCommitteeStanding(syncedOnly.instanceId, committeeId))!

      expect(standing.committeeNumId).toBe(1)
      expect(standing.totalVotes).toBe(10)
      expect(standing.totalAq).toBe(0)
    })
  })
})
