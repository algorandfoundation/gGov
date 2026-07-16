import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount } from 'algosdk'
import { MAX_ACCOUNTS_PER_INGEST_AQ } from 'frac-delegation-sdk'
import { GGovCommitteeFile } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import {
  errAccountAqExists,
  errAqIncomplete,
  errAqNotStarted,
  errCommitteeNotExists,
  errIngestedAqNotZero,
  errTotalAqExceeded,
  errTotalAqZero,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import {
  deployFracInstance,
  deployRegistryWithCommittee,
  generateAccountWithFracInstanceSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

// E2E only, no unit spec: ingestAq inner-calls the frac registry's getOrCreateAccountWithInstance,
// which clone()s FracInstance { appId: Application }. algorand-typescript-testing 1.1.0 cannot decode
// a struct with a reference-type field, so this feature is untestable under the unit harness on the
// pinned toolchain (see the describe.skip in fracDelegationRegistry.account.algo.spec.ts).

/**
 * Fresh, unfunded addresses. AQ rows are plain ARC-4 `address` values - the accounts never sign and
 * never hold state of their own - so they need no LocalNet account.
 */
const freshAccounts = (n: number) => Array.from({ length: n }, () => generateAccount().addr.toString())

/** `[address, aq]` rows in the tuple shape the generated client takes. */
const rows = (accounts: string[], aq: number): [string, number][] => accounts.map((a) => [a, aq])

/** An arbitrary committee numeric ID that was never opened. */
const UNKNOWN_COMMITTEE_NUM_ID = 999

/**
 * gGov registry with one fully-ingested committee, plus a frac registry + instance bound to it with
 * that committee synced (one escrow, since syncCommittee requires at least one). The instance's
 * operator resolves to `testAccount` (registry defaultOperator = creator).
 *
 * Both app accounts are topped up: the instance pays ~6,900 microALGO of box MBR per ingested
 * account and the registry ~19,700 per account it has never seen, and there is no funding path
 * between them. An underfunded registry fails the simulate that populates box references, which
 * surfaces as an opaque resource error rather than an overspend.
 */
const setupAq = async (localnet: AlgorandFixture) => {
  const { testAccount } = localnet.context
  const { sdk: ggovSdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
  const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
  await registrySdk.setGGovRegistryApp({ appId: ggovSdk.appId })
  await registrySdk.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
  await instanceSdk.syncCommittee({ committeeId })

  await localnet.algorand.account.ensureFundedFromEnvironment(instanceSdk.readClient.appAddress, (5).algos())
  await localnet.algorand.account.ensureFundedFromEnvironment(registrySdk.readClient.appAddress, (5).algos())

  const committeeNumId = (await instanceSdk.getCommittee(committeeId))!.committeeNumId
  return { testAccount, ggovSdk, committeeId, committeeNumId, govAccounts, registrySdk, instanceSdk, instanceId }
}

/** Register a second committee on the same gGov registry and sync it into the instance. */
const addSecondCommittee = async (ctx: Awaited<ReturnType<typeof setupAq>>, totalVotes = 25) => {
  const secondCommitteeId = await ctx.ggovSdk.uploadCommitteeFile({
    ...committeeTemplate,
    periodStart: 5_000_000,
    periodEnd: 6_000_000,
    totalMembers: 1,
    totalVotes,
    registryId: 0,
    govs: [{ address: ctx.govAccounts[0].toString(), votes: totalVotes }],
  } as GGovCommitteeFile)
  await ctx.instanceSdk.syncCommittee({ committeeId: secondCommitteeId })
  const secondNumId = (await ctx.instanceSdk.getCommittee(secondCommitteeId))!.committeeNumId
  return { secondCommitteeId, secondNumId }
}

describe('FracDelegationInstance algoquarters', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('startAqIngest', () => {
    test('opens a zero-filled ledger keyed by the committee numeric ID', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toBeUndefined()

      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 0,
        numAccounts: 0,
      })
    })

    test('re-runs to correct totalAq while the ledger is pristine', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)

      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.startAqIngest({ committeeId, totalAq: 2500 })

      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.totalAq).toBe(2500)
    })

    test('keeps a separate ledger per committee', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, instanceSdk } = ctx
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)

      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.startAqIngest({ committeeId: secondCommitteeId, totalAq: 7000 })

      expect(secondNumId).not.toBe(committeeNumId)
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.totalAq).toBe(1000)
      expect((await instanceSdk.getCommitteeAq(secondNumId))!.totalAq).toBe(7000)
    })
  })

  describe('startAqIngest rejections', () => {
    test('a non-operator cannot start', async () => {
      const { committeeId, instanceSdk } = await setupAq(localnet)
      const { sdk: nonOperatorSdk } = await generateAccountWithFracInstanceSDK(localnet, instanceSdk.appId, (3).algos())

      await expect(nonOperatorSdk.startAqIngest({ committeeId, totalAq: 1000 })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('rejects a zero total', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)

      // A zero total would be indistinguishable from the "no ledger" sentinel.
      await expect(instanceSdk.startAqIngest({ committeeId, totalAq: 0 })).rejects.toThrow(
        transformedError(errTotalAqZero),
      )
      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toBeUndefined()
    })

    test('rejects a committee that was never synced', async () => {
      const { instanceSdk } = await setupAq(localnet)

      await expect(
        instanceSdk.startAqIngest({ committeeId: new Uint8Array(32).fill(7), totalAq: 1000 }),
      ).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('rejects a totalAq re-set once AlgoQuarters have been ingested', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // The total is load-bearing for the rows already written, so it freezes on first ingest.
      await expect(instanceSdk.startAqIngest({ committeeId, totalAq: 2000 })).rejects.toThrow(
        transformedError(errIngestedAqNotZero),
      )
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.totalAq).toBe(1000)
    })
  })

  describe('ingestAq', () => {
    test('writes one box per account and accumulates the ledger', async () => {
      const { committeeId, committeeNumId, instanceSdk, registrySdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(3)

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 300,
        numAccounts: 3,
      })
      const accountIds = await registrySdk.getAccountIdMap(accounts)
      for (const account of accounts) {
        expect(await instanceSdk.getAccountAq(accountIds.get(account)!, committeeNumId)).toBe(100)
      }
    })

    test('mints a registry account ID and links every account to the instance', async () => {
      const { committeeId, committeeNumId, instanceSdk, registrySdk, instanceId } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(2)

      // Unknown to the registry until ingest resolves them: accountId 0 is the "not registered"
      // sentinel, since the counter starts at 1.
      let records = await registrySdk.getFracRegAccountsMap(accounts)
      expect(records.get(accounts[0])!.accountId).toBe(0)

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 50) })

      records = await registrySdk.getFracRegAccountsMap(accounts)
      for (const account of accounts) {
        const record = records.get(account)!
        expect(record.accountId).toBeGreaterThan(0)
        // The whole reason ingestAq calls the registry rather than taking an accountId hint.
        // instanceNumIds decodes to number; addInstance hands back bigint.
        expect(record.instanceNumIds).toContain(Number(instanceId))
      }
      expect((await registrySdk.getInstance(instanceId))!.numAccounts).toBe(2n)
    })

    test('reuses the account ID across committees and links the instance only once', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, instanceSdk, registrySdk, instanceId } = ctx
      const account = freshAccounts(1)[0]

      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })
      const firstId = (await registrySdk.getAccountIdMap([account])).get(account)!

      // A second committee, ingesting the same address again.
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await instanceSdk.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId: secondNumId, accountAqs: rows([account], 400) })

      // Same ID minted once; getOrCreateAccountWithInstance is idempotent in both dimensions, so the
      // instance link is not duplicated and numAccounts is not double-counted.
      const record = (await registrySdk.getFracRegAccountsMap([account])).get(account)!
      expect(record.accountId).toBe(firstId)
      expect(record.instanceNumIds).toEqual([Number(instanceId)])
      expect((await registrySdk.getInstance(instanceId))!.numAccounts).toBe(1n)

      // AQ is per (account, committee): the same account holds a different weight in each.
      expect(await instanceSdk.getAccountAq(firstId, committeeNumId)).toBe(100)
      expect(await instanceSdk.getAccountAq(firstId, secondNumId)).toBe(400)
    })

    test('accumulates across batches', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(2), 100) })
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(200)

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(3), 50) })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 350,
        numAccounts: 5,
      })
    })

    test('is order-independent: accepts strictly descending account IDs', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, instanceSdk, registrySdk } = ctx
      const accounts = freshAccounts(4)

      // Ingesting in order mints IDs 1..4 against these addresses.
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 10) })
      const ids = await registrySdk.getAccountIdMap(accounts)
      expect(accounts.map((a) => ids.get(a)!)).toEqual([1, 2, 3, 4])

      // Feed the same accounts to a second committee back-to-front, so the IDs arrive 4,3,2,1. The
      // gGov registry's packed superbox rejects exactly this with errOutOfOrder; a BoxMap keys by ID
      // and has no offsets to maintain, so ordering must not matter here.
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await instanceSdk.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId: secondNumId, accountAqs: rows([...accounts].reverse(), 10) })

      expect((await instanceSdk.getCommitteeAq(secondNumId))!.ingestedAq).toBe(40)
      expect(await instanceSdk.getAccountAq(ids.get(accounts[0])!, secondNumId)).toBe(10)
    })

    test('completes when ingestedAq reaches totalAq', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 300 })

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(3), 100) })

      const ledger = (await instanceSdk.getCommitteeAq(committeeNumId))!
      expect(ledger.ingestedAq).toBe(ledger.totalAq)
      // The guard internal voting will use: a complete ledger passes mustBeComplete.
      const { return: complete } = await instanceSdk.readClient.send.getCommitteeAq({
        args: { committeeNumId, mustBeComplete: true },
      })
      expect(complete!.ingestedAq).toBe(300)
    })
  })

  describe('ingestAq rejections', () => {
    test('a non-operator cannot ingest', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const { sdk: nonOperatorSdk } = await generateAccountWithFracInstanceSDK(localnet, instanceSdk.appId, (3).algos())

      await expect(
        nonOperatorSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects before startAqIngest, without registering any account', async () => {
      const { committeeNumId, instanceSdk, registrySdk } = await setupAq(localnet)
      const accounts = freshAccounts(2)

      await expect(instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })).rejects.toThrow(
        transformedError(errAqNotStarted),
      )

      // The ledger check runs before the first inner call, so the most likely operator mistake (a
      // wrong committeeNumId) mints no account IDs and creates no registry boxes.
      const records = await registrySdk.getFracRegAccountsMap(accounts)
      expect(records.get(accounts[0])!.accountId).toBe(0)
    })

    test('rejects an unknown committee numeric ID', async () => {
      const { committeeId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })

      await expect(
        instanceSdk.ingestAq({ committeeNumId: UNKNOWN_COMMITTEE_NUM_ID, accountAqs: rows(freshAccounts(1), 100) }),
      ).rejects.toThrow(transformedError(errAqNotStarted))
    })

    test('rejects a zero-AQ account', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })

      // The pipeline floors sub-1-AQ accounts out of its output, so a zero here means bad input.
      await expect(instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 0) })).rejects.toThrow(
        transformedError(errZeroAq),
      )
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(0)
    })

    test('rejects a duplicate account within one batch', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const account = freshAccounts(1)[0]

      await expect(instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account, account], 100) })).rejects.toThrow(
        transformedError(errAccountAqExists),
      )
    })

    test('rejects an account ingested in an earlier batch, without double-counting', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const account = freshAccounts(1)[0]
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })

      // A replayed batch must fail loudly rather than add to ingestedAq twice.
      await expect(instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })).rejects.toThrow(
        transformedError(errAccountAqExists),
      )
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(100)
    })

    test('rejects a batch that would exceed totalAq, leaving the ledger untouched', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 250 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(2), 100) })

      await expect(instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })).rejects.toThrow(
        transformedError(errTotalAqExceeded),
      )
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(200)
    })
  })

  describe('readers', () => {
    test('getCommitteeAq is undefined and tryGetAccountAq is 0 for an unopened committee', async () => {
      const { instanceSdk } = await setupAq(localnet)

      expect(await instanceSdk.getCommitteeAq(UNKNOWN_COMMITTEE_NUM_ID)).toBeUndefined()
      expect(await instanceSdk.getAccountAq(1, UNKNOWN_COMMITTEE_NUM_ID)).toBe(0)
    })

    test('getCommitteeAq(mustBeComplete) rejects a half-ingested ledger', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // Internal voting splits weight against totalAq, so a moving denominator must not be votable.
      await expect(
        instanceSdk.readClient.send.getCommitteeAq({ args: { committeeNumId, mustBeComplete: true } }),
      ).rejects.toThrow(transformedError(errAqIncomplete))
    })
  })

  describe('batching', () => {
    test('a full MAX_ACCOUNTS_PER_INGEST_AQ batch lands in one group', async () => {
      // The reference-slot regression net: N accounts need 2N+3 slots against 8 per app call, so a
      // full batch only sends if makeIngestAqTxns pads the group correctly. Under-padding fails with
      // "No more transactions below reference limit".
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_INGEST_AQ
      await instanceSdk.startAqIngest({ committeeId, totalAq: n * 10 })

      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(n), 10) })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: n * 10,
        ingestedAq: n * 10,
        numAccounts: n,
      })
    })

    test('ingestAqAll chunks past the per-call limit into multiple groups', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_INGEST_AQ + 5
      await instanceSdk.startAqIngest({ committeeId, totalAq: n * 10 })

      await instanceSdk.ingestAqAll({ committeeNumId, accountAqs: rows(freshAccounts(n), 10) })

      const ledger = (await instanceSdk.getCommitteeAq(committeeNumId))!
      expect(ledger.numAccounts).toBe(n)
      expect(ledger.ingestedAq).toBe(ledger.totalAq)
    })

    test('ingestAq rejects a batch over the per-call limit rather than failing on-chain', async () => {
      const { committeeNumId, instanceSdk } = await setupAq(localnet)

      await expect(
        instanceSdk.ingestAq({
          committeeNumId,
          accountAqs: rows(freshAccounts(MAX_ACCOUNTS_PER_INGEST_AQ + 1), 10),
        }),
      ).rejects.toThrow(/exceeds the .* per call/)
    })
  })
})
