import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount, getApplicationAddress, makeEmptyTransactionSigner } from 'algosdk'
import {
  MAX_ACCOUNTS_PER_INGEST_AQ,
  MAX_ACCOUNTS_PER_UNINGEST_AQ,
  FracDelegationInstanceClient,
} from 'frac-delegation-sdk'
import { GGovCommitteeFile } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import {
  errAccountAqExists,
  errAccountAqNotExists,
  errAqIncomplete,
  errAqNotStarted,
  errCommitteeNotExists,
  errIngestedAqNotZero,
  errNumAccountsExceeded,
  errTotalAccountsZero,
  errTotalAqExceeded,
  errTotalAqZero,
  errTotalGovsExceeded,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import {
  deployFracInstance,
  deployRegistryWithCommittee,
  generateAccountWithFracSDK,
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
  const { appId: instanceAppId, instanceId, sdk } = await deployFracInstance(localnet, testAccount)
  await sdk.registry.setGGovRegistryApp({ appId: ggovSdk.appId })
  await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
  await sdk.syncCommittee({ instanceNumId: instanceId, committeeId })

  await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(instanceAppId), (5).algos())
  await localnet.algorand.account.ensureFundedFromEnvironment(sdk.registryReadClient.appAddress, (5).algos())

  const committeeNumId = (await sdk.getCommittee(instanceId, committeeId))!.committeeNumId

  // The combined FracDelegationSDK addresses many instances by `instanceNumId`; the sibling
  // committees/periods specs thread it inline. This spec makes so many AQ calls that we bind it once
  // into a single-instance facade — the test bodies then read as plain per-instance calls. `readClient`
  // is a raw instance client for the readonly getCommitteeAq(mustBeComplete) simulate assertions.
  const readClient = new FracDelegationInstanceClient({
    algorand: localnet.algorand,
    appId: instanceAppId,
    defaultSender: testAccount,
    defaultSigner: makeEmptyTransactionSigner(),
  })
  const sdkWrapper = {
    startAqIngest: (args: {
      committeeId: Uint8Array | string
      totalAq: number
      totalAccounts: number
      note?: string
    }) => sdk.startAqIngest({ instanceNumId: instanceId, ...args }),
    ingestAq: (args: { committeeNumId: number; accountAqs: [string, number][]; note?: string }) =>
      sdk.ingestAq({ instanceNumId: instanceId, ...args }),
    ingestAqAll: (args: { committeeNumId: number; accountAqs: [string, number][]; note?: string }) =>
      sdk.ingestAqAll({ instanceNumId: instanceId, ...args }),
    uningestAq: (args: { committeeNumId: number; accounts: string[]; note?: string }) =>
      sdk.uningestAq({ instanceNumId: instanceId, ...args }),
    uningestAqAll: (args: { committeeNumId: number; accounts: string[]; note?: string }) =>
      sdk.uningestAqAll({ instanceNumId: instanceId, ...args }),
    getCommitteeAq: (committeeNumId: number) => sdk.getCommitteeAq(instanceId, committeeNumId),
    getAccountAq: (accountId: number, committeeNumId: number) =>
      sdk.getAccountAq(instanceId, accountId, committeeNumId),
    readClient,
  }
  return {
    testAccount,
    ggovSdk,
    committeeId,
    committeeNumId,
    govAccounts,
    registrySdk: sdk.registry,
    sdk,
    sdkWrapper,
    instanceId,
  }
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
  await ctx.sdk.syncCommittee({ instanceNumId: ctx.instanceId, committeeId: secondCommitteeId })
  const secondNumId = (await ctx.sdk.getCommittee(ctx.instanceId, secondCommitteeId))!.committeeNumId
  return { secondCommitteeId, secondNumId }
}

describe('FracDelegationInstance algoquarters', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('startAqIngest', () => {
    test('opens a zero-filled ledger keyed by the committee numeric ID', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toBeUndefined()

      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })

      // Both declared totals are stored up front; ingestedAq/numAccounts start at zero.
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 0,
        totalAccounts: 10,
        numAccounts: 0,
      })
    })

    test('re-runs to correct both totals while the ledger is pristine', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)

      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 2500, totalAccounts: 25 })

      const ledger = (await sdkWrapper.getCommitteeAq(committeeNumId))!
      expect(ledger.totalAq).toBe(2500)
      expect(ledger.totalAccounts).toBe(25)
    })

    test('keeps a separate ledger per committee', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, sdkWrapper } = ctx
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)

      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.startAqIngest({ committeeId: secondCommitteeId, totalAq: 7000, totalAccounts: 70 })

      expect(secondNumId).not.toBe(committeeNumId)
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.totalAq).toBe(1000)
      expect((await sdkWrapper.getCommitteeAq(secondNumId))!.totalAq).toBe(7000)
    })
  })

  describe('startAqIngest rejections', () => {
    test('a non-operator cannot start', async () => {
      const { committeeId, sdk, instanceId } = await setupAq(localnet)
      const { sdk: nonOperatorSdk } = await generateAccountWithFracSDK(localnet, sdk.appId, (3).algos())

      await expect(
        nonOperatorSdk.startAqIngest({ instanceNumId: instanceId, committeeId, totalAq: 1000, totalAccounts: 10 }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects a zero total AQ', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)

      // A zero total would be indistinguishable from the "no ledger" sentinel.
      await expect(sdkWrapper.startAqIngest({ committeeId, totalAq: 0, totalAccounts: 10 })).rejects.toThrow(
        transformedError(errTotalAqZero),
      )
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toBeUndefined()
    })

    test('rejects a zero total accounts', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)

      // Mirrors the totalAq guard: a ledger that expects zero accounts could never complete, since
      // ingestAq rejects any batch that would push numAccounts past totalAccounts.
      await expect(sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 0 })).rejects.toThrow(
        transformedError(errTotalAccountsZero),
      )
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toBeUndefined()
    })

    test('rejects a committee that was never synced', async () => {
      const { sdkWrapper } = await setupAq(localnet)

      await expect(
        sdkWrapper.startAqIngest({ committeeId: new Uint8Array(32).fill(7), totalAq: 1000, totalAccounts: 10 }),
      ).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('rejects a totals re-set once AlgoQuarters have been ingested', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // The totals are load-bearing for the rows already written, so they freeze on first ingest.
      await expect(sdkWrapper.startAqIngest({ committeeId, totalAq: 2000, totalAccounts: 20 })).rejects.toThrow(
        transformedError(errIngestedAqNotZero),
      )
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.totalAq).toBe(1000)
    })
  })

  describe('ingestAq', () => {
    test('writes one box per account and accumulates the ledger', async () => {
      const { committeeId, committeeNumId, sdkWrapper, registrySdk } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(3)

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 300,
        totalAccounts: 10,
        numAccounts: 3,
      })
      const accountIds = await registrySdk.getAccountIdMap(accounts)
      for (const account of accounts) {
        expect(await sdkWrapper.getAccountAq(accountIds.get(account)!, committeeNumId)).toBe(100)
      }
    })

    test('mints a registry account ID and links every account to the instance', async () => {
      const { committeeId, committeeNumId, sdkWrapper, registrySdk, instanceId } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(2)

      // Unknown to the registry until ingest resolves them: accountId 0 is the "not registered"
      // sentinel, since the counter starts at 1.
      let records = await registrySdk.getFracRegAccountsMap(accounts)
      expect(records.get(accounts[0])!.accountId).toBe(0)

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 50) })

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
      const { committeeId, committeeNumId, sdkWrapper, registrySdk, instanceId } = ctx
      const account = freshAccounts(1)[0]

      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })
      const firstId = (await registrySdk.getAccountIdMap([account])).get(account)!

      // A second committee, ingesting the same address again.
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await sdkWrapper.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId: secondNumId, accountAqs: rows([account], 400) })

      // Same ID minted once; getOrCreateAccountWithInstance is idempotent in both dimensions, so the
      // instance link is not duplicated and numAccounts is not double-counted.
      const record = (await registrySdk.getFracRegAccountsMap([account])).get(account)!
      expect(record.accountId).toBe(firstId)
      expect(record.instanceNumIds).toEqual([Number(instanceId)])
      expect((await registrySdk.getInstance(instanceId))!.numAccounts).toBe(1n)

      // AQ is per (account, committee): the same account holds a different weight in each.
      expect(await sdkWrapper.getAccountAq(firstId, committeeNumId)).toBe(100)
      expect(await sdkWrapper.getAccountAq(firstId, secondNumId)).toBe(400)
    })

    test('accumulates across batches', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(2), 100) })
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(200)

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(3), 50) })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 350,
        totalAccounts: 10,
        numAccounts: 5,
      })
    })

    test('is order-independent: accepts strictly descending account IDs', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, sdkWrapper, registrySdk } = ctx
      const accounts = freshAccounts(4)

      // Ingesting in order mints IDs 1..4 against these addresses.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 10) })
      const ids = await registrySdk.getAccountIdMap(accounts)
      expect(accounts.map((a) => ids.get(a)!)).toEqual([1, 2, 3, 4])

      // Feed the same accounts to a second committee back-to-front, so the IDs arrive 4,3,2,1. The
      // gGov registry's packed superbox rejects exactly this with errOutOfOrder; a BoxMap keys by ID
      // and has no offsets to maintain, so ordering must not matter here. Give each account a distinct
      // weight so the assertions below prove the descending arrival attributed every weight to the
      // right ID — with uniform weights a scrambled ID->AQ mapping would pass unnoticed.
      const weightOf = new Map(accounts.map((a, i) => [a, (i + 1) * 10])) // a0=10, a1=20, a2=30, a3=40
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await sdkWrapper.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({
        committeeNumId: secondNumId,
        accountAqs: [...accounts].reverse().map((a): [string, number] => [a, weightOf.get(a)!]),
      })

      // The sum is order-independent, and each ID carries exactly the weight of its own account.
      expect((await sdkWrapper.getCommitteeAq(secondNumId))!.ingestedAq).toBe(100)
      for (const account of accounts) {
        expect(await sdkWrapper.getAccountAq(ids.get(account)!, secondNumId)).toBe(weightOf.get(account)!)
      }
    })

    test('completes when both ingestedAq and numAccounts reach their totals', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 300, totalAccounts: 3 })

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(3), 100) })

      const ledger = (await sdkWrapper.getCommitteeAq(committeeNumId))!
      expect(ledger.ingestedAq).toBe(ledger.totalAq)
      expect(ledger.numAccounts).toBe(ledger.totalAccounts)
      // The guard internal voting will use: a ledger with BOTH totals reached passes mustBeComplete.
      const { return: complete } = await sdkWrapper.readClient.send.getCommitteeAq({
        args: { committeeNumId, mustBeComplete: true },
      })
      expect(complete!.ingestedAq).toBe(300)
      expect(complete!.numAccounts).toBe(3)
    })

    test('mustBeComplete rejects when the AQ total is met but accounts are short', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      // 3 accounts x 100 hits totalAq exactly, but the ledger declares a 4th account still to come.
      // AQ-complete is not enough; the account count must also be reached.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 300, totalAccounts: 4 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(3), 100) })

      const ledger = (await sdkWrapper.getCommitteeAq(committeeNumId))!
      expect(ledger.ingestedAq).toBe(ledger.totalAq)
      expect(ledger.numAccounts).not.toBe(ledger.totalAccounts)
      await expect(
        sdkWrapper.readClient.send.getCommitteeAq({ args: { committeeNumId, mustBeComplete: true } }),
      ).rejects.toThrow(transformedError(errAqIncomplete))
    })
  })

  describe('ingestAq rejections', () => {
    test('a non-operator cannot ingest', async () => {
      const { committeeId, committeeNumId, sdkWrapper, sdk, instanceId } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const { sdk: nonOperatorSdk } = await generateAccountWithFracSDK(localnet, sdk.appId, (3).algos())

      await expect(
        nonOperatorSdk.ingestAq({ instanceNumId: instanceId, committeeNumId, accountAqs: rows(freshAccounts(1), 100) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects before startAqIngest, without registering any account', async () => {
      const { committeeNumId, sdkWrapper, registrySdk } = await setupAq(localnet)
      const accounts = freshAccounts(2)

      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })).rejects.toThrow(
        transformedError(errAqNotStarted),
      )

      // The ledger check runs before the first inner call, so the most likely operator mistake (a
      // wrong committeeNumId) mints no account IDs and creates no registry boxes.
      const records = await registrySdk.getFracRegAccountsMap(accounts)
      expect(records.get(accounts[0])!.accountId).toBe(0)
    })

    test('rejects an unknown committee numeric ID', async () => {
      const { committeeId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })

      await expect(
        sdkWrapper.ingestAq({ committeeNumId: UNKNOWN_COMMITTEE_NUM_ID, accountAqs: rows(freshAccounts(1), 100) }),
      ).rejects.toThrow(transformedError(errAqNotStarted))
    })

    test('rejects a zero-AQ account', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })

      // The pipeline floors sub-1-AQ accounts out of its output, so a zero here means bad input.
      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 0) })).rejects.toThrow(
        transformedError(errZeroAq),
      )
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(0)
    })

    test('rejects a duplicate account within one batch', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const account = freshAccounts(1)[0]

      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account, account], 100) })).rejects.toThrow(
        transformedError(errAccountAqExists),
      )
    })

    test('rejects an account ingested in an earlier batch, without double-counting', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const account = freshAccounts(1)[0]
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })

      // A replayed batch must fail loudly rather than add to ingestedAq twice.
      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })).rejects.toThrow(
        transformedError(errAccountAqExists),
      )
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(100)
    })

    test('rejects a batch that would exceed totalAq, leaving the ledger untouched', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      // totalAccounts is generous so the AQ guard is the one that fires, not the account-count guard.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 250, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(2), 100) })

      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })).rejects.toThrow(
        transformedError(errTotalAqExceeded),
      )
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(200)
    })

    test('rejects a batch that would exceed totalAccounts, leaving the ledger untouched', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      // totalAq is generous so the account-count guard is the one that fires: a 3rd account overflows
      // the declared 2, even though its AQ still fits comfortably under totalAq.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 2 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(2), 10) })

      await expect(sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 10) })).rejects.toThrow(
        transformedError(errTotalGovsExceeded),
      )
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 20,
        totalAccounts: 2,
        numAccounts: 2,
      })
    })
  })

  describe('uningestAq', () => {
    test('removes accounts and rolls back ingestedAq / numAccounts', async () => {
      const { committeeId, committeeNumId, instanceSdk, registrySdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(3)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      await instanceSdk.uningestAq({ committeeNumId, accounts: accounts.slice(0, 2) })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 100,
        numAccounts: 1,
      })
      const ids = await registrySdk.getAccountIdMap(accounts)
      expect(await instanceSdk.getAccountAq(ids.get(accounts[0])!, committeeNumId)).toBe(0) // removed
      expect(await instanceSdk.getAccountAq(ids.get(accounts[2])!, committeeNumId)).toBe(100) // kept
    })

    test('frees the instance box MBR it locked', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(3)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      const appAddress = instanceSdk.readClient.appAddress
      const before = (await localnet.algorand.account.getInformation(appAddress)).minBalance.microAlgo
      await instanceSdk.uningestAq({ committeeNumId, accounts })
      const after = (await localnet.algorand.account.getInformation(appAddress)).minBalance.microAlgo

      // Deleting a box lowers the app account's minimum balance by that box's MBR. Each accountAq box
      // is 2500 + 400 * (7-byte name + 4-byte value) = 6900 microALGO; the ALGO becomes spendable and
      // is recoverable with withdrawALGO.
      expect(before - after).toBe(3n * 6_900n)
    })

    test('draining to zero re-opens startAqIngest for a corrected total', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(2)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      // Frozen while any AQ are ingested.
      await expect(instanceSdk.startAqIngest({ committeeId, totalAq: 5000 })).rejects.toThrow(
        transformedError(errIngestedAqNotZero),
      )

      await instanceSdk.uningestAq({ committeeNumId, accounts })
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(0)

      // Unfrozen: a fresh total can now be committed.
      await instanceSdk.startAqIngest({ committeeId, totalAq: 5000 })
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.totalAq).toBe(5000)
    })

    test('leaves the registry account record and instance association intact', async () => {
      const { committeeId, committeeNumId, instanceSdk, registrySdk, instanceId } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(2)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      await instanceSdk.uningestAq({ committeeNumId, accounts })

      // Account IDs are permanent and the account->instance link stays - uningest only deletes the
      // instance's own accountAq boxes, never touching the registry.
      const records = await registrySdk.getFracRegAccountsMap(accounts)
      for (const account of accounts) {
        expect(records.get(account)!.accountId).toBeGreaterThan(0)
        expect(records.get(account)!.instanceNumIds).toContain(Number(instanceId))
      }
      expect((await registrySdk.getInstance(instanceId))!.numAccounts).toBe(2n)
    })

    test('is order-independent', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(4)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 25) })

      // Remove in a different order than ingested - a BoxMap deletes by key, no offset to keep.
      await instanceSdk.uningestAq({ committeeNumId, accounts: [...accounts].reverse() })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 0,
        numAccounts: 0,
      })
    })
  })

  describe('uningestAq rejections', () => {
    test('a non-operator cannot uningest', async () => {
      const { committeeId, committeeNumId, instanceSdk, sdk, instanceId } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const account = freshAccounts(1)[0]
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })
      const { sdk: nonOperatorSdk } = await generateAccountWithFracSDK(localnet, sdk.appId, (3).algos())

      await expect(
        nonOperatorSdk.uningestAq({ instanceNumId: instanceId, committeeNumId, accounts: [account] }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects when the ledger was never started', async () => {
      const { committeeNumId, instanceSdk } = await setupAq(localnet)

      await expect(instanceSdk.uningestAq({ committeeNumId, accounts: freshAccounts(1) })).rejects.toThrow(
        transformedError(errAqNotStarted),
      )
    })

    test('rejects an account the registry has never seen', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // A fresh address resolves to account ID 0, whose box never exists.
      await expect(instanceSdk.uningestAq({ committeeNumId, accounts: freshAccounts(1) })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.numAccounts).toBe(1)
    })

    test('rejects an account registered but not ingested into this committee', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, instanceSdk } = ctx
      const account = freshAccounts(1)[0]
      // Registered by ingesting into the first committee.
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })

      // The second committee knows the account's ID but holds no box for it. Ingest a filler so its
      // numAccounts is 1 - otherwise the cheap count guard (errNumAccountsExceeded) fires first,
      // before the per-account box-exists check this test is exercising.
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await instanceSdk.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId: secondNumId, accountAqs: rows(freshAccounts(1), 50) })

      await expect(instanceSdk.uningestAq({ committeeNumId: secondNumId, accounts: [account] })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
    })

    test('rejects a duplicate account within one batch, reverting the whole group', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      const accounts = freshAccounts(2)
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      // length 2 <= numAccounts 2 clears the count guard; the second pass finds the box already gone.
      await expect(instanceSdk.uningestAq({ committeeNumId, accounts: [accounts[0], accounts[0]] })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
      // Atomic: nothing was removed.
      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.numAccounts).toBe(2)
    })

    test('rejects a batch larger than the ingested account count', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      await instanceSdk.startAqIngest({ committeeId, totalAq: 1000 })
      await instanceSdk.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      await expect(instanceSdk.uningestAq({ committeeNumId, accounts: freshAccounts(2) })).rejects.toThrow(
        transformedError(errNumAccountsExceeded),
      )
    })
  })

  describe('readers', () => {
    test('getCommitteeAq is undefined and tryGetAccountAq is 0 for an unopened committee', async () => {
      const { sdkWrapper } = await setupAq(localnet)

      expect(await sdkWrapper.getCommitteeAq(UNKNOWN_COMMITTEE_NUM_ID)).toBeUndefined()
      expect(await sdkWrapper.getAccountAq(1, UNKNOWN_COMMITTEE_NUM_ID)).toBe(0)
    })

    test('getCommitteeAq(mustBeComplete) rejects a half-ingested ledger', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // Internal voting splits weight against totalAq, so a moving denominator must not be votable.
      await expect(
        sdkWrapper.readClient.send.getCommitteeAq({ args: { committeeNumId, mustBeComplete: true } }),
      ).rejects.toThrow(transformedError(errAqIncomplete))
    })
  })

  describe('batching', () => {
    test('a full MAX_ACCOUNTS_PER_INGEST_AQ batch lands in one group', async () => {
      // The reference-slot regression net: N accounts need 2N+3 slots against 8 per app call, so a
      // full batch only sends if makeIngestAqTxns pads the group correctly. Under-padding fails with
      // "No more transactions below reference limit".
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_INGEST_AQ
      await sdkWrapper.startAqIngest({ committeeId, totalAq: n * 10, totalAccounts: n })

      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(n), 10) })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: n * 10,
        ingestedAq: n * 10,
        totalAccounts: n,
        numAccounts: n,
      })
    })

    test('ingestAqAll chunks past the per-call limit into multiple groups', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_INGEST_AQ + 5
      await sdkWrapper.startAqIngest({ committeeId, totalAq: n * 10, totalAccounts: n })

      await sdkWrapper.ingestAqAll({ committeeNumId, accountAqs: rows(freshAccounts(n), 10) })

      const ledger = (await sdkWrapper.getCommitteeAq(committeeNumId))!
      expect(ledger.numAccounts).toBe(n)
      expect(ledger.ingestedAq).toBe(ledger.totalAq)
    })

    test('ingestAq rejects a batch over the per-call limit rather than failing on-chain', async () => {
      const { committeeNumId, sdkWrapper } = await setupAq(localnet)

      await expect(
        sdkWrapper.ingestAq({
          committeeNumId,
          accountAqs: rows(freshAccounts(MAX_ACCOUNTS_PER_INGEST_AQ + 1), 10),
        }),
      ).rejects.toThrow(/exceeds the .* per call/)
    })

    test('a full MAX_ACCOUNTS_PER_UNINGEST_AQ uningest lands in one group', async () => {
      // Reference-slot regression net for the reverse path: N accounts need 2N+2 slots, so a full
      // batch only sends if makeUningestAqTxns pads the group correctly.
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_UNINGEST_AQ
      await instanceSdk.startAqIngest({ committeeId, totalAq: n * 10 })
      const accounts = freshAccounts(n)
      await instanceSdk.ingestAqAll({ committeeNumId, accountAqs: rows(accounts, 10) })

      await instanceSdk.uningestAq({ committeeNumId, accounts })

      expect(await instanceSdk.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: n * 10,
        ingestedAq: 0,
        numAccounts: 0,
      })
    })

    test('uningestAqAll chunks past the per-call limit into multiple groups', async () => {
      const { committeeId, committeeNumId, instanceSdk } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_UNINGEST_AQ + 5
      await instanceSdk.startAqIngest({ committeeId, totalAq: n * 10 })
      const accounts = freshAccounts(n)
      await instanceSdk.ingestAqAll({ committeeNumId, accountAqs: rows(accounts, 10) })

      await instanceSdk.uningestAqAll({ committeeNumId, accounts })

      expect((await instanceSdk.getCommitteeAq(committeeNumId))!.numAccounts).toBe(0)
    })

    test('uningestAq rejects a batch over the per-call limit rather than failing on-chain', async () => {
      const { committeeNumId, instanceSdk } = await setupAq(localnet)

      await expect(
        instanceSdk.uningestAq({ committeeNumId, accounts: freshAccounts(MAX_ACCOUNTS_PER_UNINGEST_AQ + 1) }),
      ).rejects.toThrow(/exceeds the .* per call/)
    })
  })
})
