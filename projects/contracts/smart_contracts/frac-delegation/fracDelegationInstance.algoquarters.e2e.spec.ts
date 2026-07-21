import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount, getApplicationAddress, makeEmptyTransactionSigner } from 'algosdk'
import {
  AlgoQuartersFile,
  FracDelegationInstanceClient,
  MAX_ACCOUNTS_PER_INGEST_AQ,
  MAX_ACCOUNTS_PER_UNINGEST_AQ,
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

/**
 * Manifest-shaped `AlgoQuartersFile` over `[address, aq]` rows: totals computed from the rows and
 * the genesis hash taken from LocalNet, so it passes `uploadAqFile`'s client-side validation.
 */
const makeAqFile = async (
  localnet: AlgorandFixture,
  accountAqs: [string, number][],
  overrides: Partial<AlgoQuartersFile> = {},
): Promise<AlgoQuartersFile> => {
  const sp = await localnet.algorand.getSuggestedParams()
  return {
    networkGenesisHash: Buffer.from(sp.genesisHash!).toString('base64'),
    protocol: 'reti',
    periodStart: 1_000_000,
    periodEnd: 2_000_000,
    totalAccounts: accountAqs.length,
    totalAlgoQuarters: accountAqs.reduce((sum, [, aq]) => sum + aq, 0).toString(),
    accounts: accountAqs.map(([account, aq]) => ({ account, algoQuarters: aq.toString() })),
    ...overrides,
  }
}

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
    getAccountAqs: (committeeNumId: number, accountIds: number[]) =>
      sdk.getAccountAqs(instanceId, committeeNumId, accountIds),
    getAccountAqMap: (committeeNumId: number, accounts?: string[]) =>
      sdk.getAccountAqMap(instanceId, committeeNumId, accounts),
    uploadAqFile: (args: {
      committeeId: Uint8Array | string
      aqFile: AlgoQuartersFile
      autoFund?: boolean
      note?: string
    }) => sdk.uploadAqFile({ instanceNumId: instanceId, ...args }),
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
      const { committeeId, committeeNumId, sdkWrapper, registrySdk } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(3)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      await sdkWrapper.uningestAq({ committeeNumId, accounts: accounts.slice(0, 2) })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 100,
        totalAccounts: 10,
        numAccounts: 1,
      })
      const ids = await registrySdk.getAccountIdMap(accounts)
      expect(await sdkWrapper.getAccountAq(ids.get(accounts[0])!, committeeNumId)).toBe(0) // removed
      expect(await sdkWrapper.getAccountAq(ids.get(accounts[2])!, committeeNumId)).toBe(100) // kept
    })

    test('frees the instance box MBR it locked', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(3)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      const appAddress = sdkWrapper.readClient.appAddress
      const before = (await localnet.algorand.account.getInformation(appAddress)).minBalance.microAlgo
      await sdkWrapper.uningestAq({ committeeNumId, accounts })
      const after = (await localnet.algorand.account.getInformation(appAddress)).minBalance.microAlgo

      // Deleting a box lowers the app account's minimum balance by that box's MBR. Each accountAq box
      // is 2500 + 400 * (7-byte name + 4-byte value) = 6900 microALGO; the ALGO becomes spendable and
      // is recoverable with withdrawALGO.
      expect(before - after).toBe(3n * 6_900n)
    })

    test('draining to zero re-opens startAqIngest for a corrected total', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(2)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      // Frozen while any AQ are ingested.
      await expect(sdkWrapper.startAqIngest({ committeeId, totalAq: 5000, totalAccounts: 50 })).rejects.toThrow(
        transformedError(errIngestedAqNotZero),
      )

      await sdkWrapper.uningestAq({ committeeNumId, accounts })
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.ingestedAq).toBe(0)

      // Unfrozen: a fresh total can now be committed.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 5000, totalAccounts: 50 })
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.totalAq).toBe(5000)
    })

    test('leaves the registry account record and instance association intact', async () => {
      const { committeeId, committeeNumId, sdkWrapper, registrySdk, instanceId } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(2)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      await sdkWrapper.uningestAq({ committeeNumId, accounts })

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
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(4)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 25) })

      // Remove in a different order than ingested - a BoxMap deletes by key, no offset to keep.
      await sdkWrapper.uningestAq({ committeeNumId, accounts: [...accounts].reverse() })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: 1000,
        ingestedAq: 0,
        totalAccounts: 10,
        numAccounts: 0,
      })
    })
  })

  describe('uningestAq rejections', () => {
    test('a non-operator cannot uningest', async () => {
      const { committeeId, committeeNumId, sdkWrapper, sdk, instanceId } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const account = freshAccounts(1)[0]
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })
      const { sdk: nonOperatorSdk } = await generateAccountWithFracSDK(localnet, sdk.appId, (3).algos())

      await expect(
        nonOperatorSdk.uningestAq({ instanceNumId: instanceId, committeeNumId, accounts: [account] }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects when the ledger was never started', async () => {
      const { committeeNumId, sdkWrapper } = await setupAq(localnet)

      await expect(sdkWrapper.uningestAq({ committeeNumId, accounts: freshAccounts(1) })).rejects.toThrow(
        transformedError(errAqNotStarted),
      )
    })

    test('rejects an account the registry has never seen', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(freshAccounts(1), 100) })

      // A fresh address resolves to account ID 0, whose box never exists.
      await expect(sdkWrapper.uningestAq({ committeeNumId, accounts: freshAccounts(1) })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.numAccounts).toBe(1)
    })

    test('rejects an account registered but not ingested into this committee', async () => {
      const ctx = await setupAq(localnet)
      const { committeeId, committeeNumId, sdkWrapper } = ctx
      const account = freshAccounts(1)[0]
      // Registered by ingesting into the first committee.
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows([account], 100) })

      // The second committee knows the account's ID (IDs are registry-wide) but holds no box for it,
      // so the per-account box-exists check rejects it.
      const { secondCommitteeId, secondNumId } = await addSecondCommittee(ctx)
      await sdkWrapper.startAqIngest({ committeeId: secondCommitteeId, totalAq: 1000, totalAccounts: 10 })

      await expect(sdkWrapper.uningestAq({ committeeNumId: secondNumId, accounts: [account] })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
    })

    test('rejects a duplicate account within one batch, reverting the whole group', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(2)
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: rows(accounts, 100) })

      // The second pass finds the box already gone, so the whole group reverts.
      await expect(sdkWrapper.uningestAq({ committeeNumId, accounts: [accounts[0], accounts[0]] })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
      // Atomic: nothing was removed.
      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.numAccounts).toBe(2)
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
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_UNINGEST_AQ
      await sdkWrapper.startAqIngest({ committeeId, totalAq: n * 10, totalAccounts: n })
      const accounts = freshAccounts(n)
      await sdkWrapper.ingestAqAll({ committeeNumId, accountAqs: rows(accounts, 10) })

      await sdkWrapper.uningestAq({ committeeNumId, accounts })

      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual({
        totalAq: n * 10,
        ingestedAq: 0,
        totalAccounts: n,
        numAccounts: 0,
      })
    })

    test('uningestAqAll chunks past the per-call limit into multiple groups', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const n = MAX_ACCOUNTS_PER_UNINGEST_AQ + 5
      await sdkWrapper.startAqIngest({ committeeId, totalAq: n * 10, totalAccounts: n })
      const accounts = freshAccounts(n)
      await sdkWrapper.ingestAqAll({ committeeNumId, accountAqs: rows(accounts, 10) })

      await sdkWrapper.uningestAqAll({ committeeNumId, accounts })

      expect((await sdkWrapper.getCommitteeAq(committeeNumId))!.numAccounts).toBe(0)
    })

    test('uningestAq rejects a batch over the per-call limit rather than failing on-chain', async () => {
      const { committeeNumId, sdkWrapper } = await setupAq(localnet)

      await expect(
        sdkWrapper.uningestAq({ committeeNumId, accounts: freshAccounts(MAX_ACCOUNTS_PER_UNINGEST_AQ + 1) }),
      ).rejects.toThrow(/exceeds the .* per call/)
    })
  })

  describe('getAccountAqs (plural reader)', () => {
    test('returns AQ per account ID, index-aligned, 0 for missing', async () => {
      const { committeeId, committeeNumId, sdkWrapper, registrySdk } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const accounts = freshAccounts(3)
      await sdkWrapper.ingestAq({
        committeeNumId,
        accountAqs: [
          [accounts[0], 100],
          [accounts[1], 150],
          [accounts[2], 200],
        ],
      })

      const ids = await registrySdk.getAccountIdMap(accounts)
      const aqs = await sdkWrapper.getAccountAqs(committeeNumId, [
        ids.get(accounts[1])!,
        9999, // never minted
        ids.get(accounts[0])!,
      ])
      expect(aqs).toEqual([150, 0, 100])
    })

    test('getAccountAqMap maps addresses to AQ, 0 for unregistered accounts', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 1000, totalAccounts: 10 })
      const [ingested, stranger] = [freshAccounts(1)[0], freshAccounts(1)[0]]
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: [[ingested, 100]] })

      const aqMap = await sdkWrapper.getAccountAqMap(committeeNumId, [ingested, stranger])
      expect(aqMap.get(ingested)).toBe(100)
      expect(aqMap.get(stranger)).toBe(0)
    })

    test('fans out past the per-call and per-group chunk limits', async () => {
      // 300 IDs exercise both chunk layers: 63 per call (each id is one box ref, and a simulate
      // group carries at most 128 unnamed refs), two calls per group, @chunked(126) fan-out.
      // The boxes need not exist — a missing box reads as 0 — so this is simulate-only and cheap.
      const { committeeNumId, sdkWrapper } = await setupAq(localnet)
      const ids = Array.from({ length: 300 }, (_, i) => i + 1)

      const aqs = await sdkWrapper.getAccountAqs(committeeNumId, ids)
      expect(aqs).toHaveLength(300)
      expect(aqs.every((aq) => aq === 0)).toBe(true)
    })
  })

  describe('uploadAqFile', () => {
    test('uploads a manifest end-to-end into a fresh ledger', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const accounts = freshAccounts(5)
      const aqFile = await makeAqFile(
        localnet,
        accounts.map((account, i): [string, number] => [account, (i + 1) * 100]),
      )

      const { committeeNumId: numId, committeeAq } = await sdkWrapper.uploadAqFile({ committeeId, aqFile })

      expect(numId).toBe(committeeNumId)
      expect(committeeAq).toEqual({ totalAq: 1500, ingestedAq: 1500, totalAccounts: 5, numAccounts: 5 })
      const aqMap = await sdkWrapper.getAccountAqMap(committeeNumId, accounts)
      expect(accounts.map((account) => aqMap.get(account))).toEqual([100, 200, 300, 400, 500])
    })

    test('re-running against a complete ledger is a no-op', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const aqFile = await makeAqFile(localnet, rows(freshAccounts(3), 100))

      await sdkWrapper.uploadAqFile({ committeeId, aqFile })
      const { committeeAq } = await sdkWrapper.uploadAqFile({ committeeId, aqFile })

      expect(committeeAq).toEqual({ totalAq: 300, ingestedAq: 300, totalAccounts: 3, numAccounts: 3 })
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual(committeeAq)
    })

    test('resumes after a partial manual ingest, skipping ingested accounts', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const accounts = freshAccounts(4)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 400, totalAccounts: 4 })
      await sdkWrapper.ingestAq({
        committeeNumId,
        accountAqs: [
          [accounts[0], 100],
          [accounts[1], 100],
        ],
      })

      const aqFile = await makeAqFile(localnet, rows(accounts, 100))
      const { committeeAq } = await sdkWrapper.uploadAqFile({ committeeId, aqFile })

      expect(committeeAq.ingestedAq).toBe(400)
      expect(committeeAq.numAccounts).toBe(4)
    })

    test('syncs the committee when it has no local snapshot', async () => {
      const ctx = await setupAq(localnet)
      const thirdCommitteeId = await ctx.ggovSdk.uploadCommitteeFile({
        ...committeeTemplate,
        periodStart: 7_000_000,
        periodEnd: 8_000_000,
        totalMembers: 1,
        totalVotes: 25,
        registryId: 0,
        govs: [{ address: ctx.govAccounts[0].toString(), votes: 25 }],
      } as GGovCommitteeFile)
      expect(await ctx.sdk.getCommittee(ctx.instanceId, thirdCommitteeId)).toBeUndefined()

      const aqFile = await makeAqFile(localnet, rows(freshAccounts(2), 50))
      const { committeeAq } = await ctx.sdkWrapper.uploadAqFile({ committeeId: thirdCommitteeId, aqFile })

      expect(await ctx.sdk.getCommittee(ctx.instanceId, thirdCommitteeId)).toBeDefined()
      expect(committeeAq.ingestedAq).toBe(100)
    })

    test('corrects the totals of a pristine ledger', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 999, totalAccounts: 9 })

      const aqFile = await makeAqFile(localnet, rows(freshAccounts(3), 100))
      const { committeeAq } = await sdkWrapper.uploadAqFile({ committeeId, aqFile })

      expect(committeeAq).toEqual({ totalAq: 300, ingestedAq: 300, totalAccounts: 3, numAccounts: 3 })
      expect(await sdkWrapper.getCommitteeAq(committeeNumId)).toEqual(committeeAq)
    })

    test('rejects a manifest whose totals differ from a frozen ledger', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const accounts = freshAccounts(4)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 400, totalAccounts: 4 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: [[accounts[0], 100]] })

      // Internally consistent file (300 AQ / 3 accounts), but the ledger froze at 400 / 4.
      const aqFile = await makeAqFile(localnet, rows(accounts.slice(0, 3), 100))
      await expect(sdkWrapper.uploadAqFile({ committeeId, aqFile })).rejects.toThrow(/frozen/)
    })

    test('rejects when an ingested account differs from its manifest row', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      const accounts = freshAccounts(3)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 300, totalAccounts: 3 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: [[accounts[0], 100]] })

      const aqFile = await makeAqFile(localnet, [
        [accounts[0], 150],
        [accounts[1], 100],
        [accounts[2], 50],
      ])
      await expect(sdkWrapper.uploadAqFile({ committeeId, aqFile })).rejects.toThrow(/already ingested with 100/)
    })

    test('rejects a ledger holding accounts outside the manifest', async () => {
      const { committeeId, committeeNumId, sdkWrapper } = await setupAq(localnet)
      await sdkWrapper.startAqIngest({ committeeId, totalAq: 300, totalAccounts: 3 })
      await sdkWrapper.ingestAq({ committeeNumId, accountAqs: [[freshAccounts(1)[0], 100]] })

      // Same totals, but none of the file's accounts are the one already ingested.
      const aqFile = await makeAqFile(localnet, rows(freshAccounts(3), 100))
      await expect(sdkWrapper.uploadAqFile({ committeeId, aqFile })).rejects.toThrow(/wrong manifest/)
    })

    test('rejects invalid manifests client-side, before any transaction', async () => {
      const { committeeId, sdkWrapper } = await setupAq(localnet)
      const good = await makeAqFile(localnet, rows(freshAccounts(2), 100))

      await expect(sdkWrapper.uploadAqFile({ committeeId, aqFile: { ...good, totalAccounts: 3 } })).rejects.toThrow(
        /totalAccounts/,
      )
      await expect(
        sdkWrapper.uploadAqFile({ committeeId, aqFile: { ...good, totalAlgoQuarters: '999' } }),
      ).rejects.toThrow(/totalAlgoQuarters/)
      const dup = good.accounts[0].account
      await expect(
        sdkWrapper.uploadAqFile({
          committeeId,
          aqFile: await makeAqFile(localnet, [
            [dup, 100],
            [dup, 100],
          ]),
        }),
      ).rejects.toThrow(/duplicate/)
      await expect(
        sdkWrapper.uploadAqFile({ committeeId, aqFile: await makeAqFile(localnet, [[freshAccounts(1)[0], 0]]) }),
      ).rejects.toThrow(/out of uint32 range/)
      await expect(
        sdkWrapper.uploadAqFile({ committeeId, aqFile: { ...good, networkGenesisHash: 'bm90LXRoaXMtbmV0d29yaw==' } }),
      ).rejects.toThrow(/genesis/)
    })

    test('pre-checks MBR with the exact shortfall; autoFund tops it up', async () => {
      const { committeeId, sdkWrapper, sdk, instanceId, testAccount } = await setupAq(localnet)
      // Drain the instance app to 15,000 µA spendable: enough for the ledger box (10,100 µA MBR),
      // not for the batch's three accountAq boxes (3 x 6,900 µA).
      const instanceAppId = await sdk.getInstanceAppId(instanceId)
      const appAddress = getApplicationAddress(instanceAppId).toString()
      const info = await localnet.algorand.client.algod.accountInformation(appAddress).do()
      const drain = BigInt(info.amount) - BigInt(info.minBalance) - 15_000n
      await sdk.withdrawInstanceALGO({ instanceNumId: instanceId, receiver: testAccount.toString(), amount: drain })

      const aqFile = await makeAqFile(localnet, rows(freshAccounts(3), 100))
      await expect(sdkWrapper.uploadAqFile({ committeeId, aqFile })).rejects.toThrow(/instance app .* µAlgo/)

      const { committeeAq } = await sdkWrapper.uploadAqFile({ committeeId, aqFile, autoFund: true })
      expect(committeeAq.numAccounts).toBe(3)
    })
  })
})
