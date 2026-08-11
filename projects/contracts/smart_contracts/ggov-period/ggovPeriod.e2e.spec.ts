import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { createHash } from 'node:crypto'
import { ABIType, ABIValue, Address, encodeAddress, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovSDK, GGovRegistrySDK, GGovRegistryFactory, GGovPeriodFactory, GGovPeriodClient } from 'ggov-sdk'
import { GGovCommitteeFile } from 'ggov-sdk'
import {
  errAccountNotExists,
  errGGovCannotOverride,
  errGGovDelegationNoAcctRef,
  errGGovHasVotes,
  errGGovLastOptionAbstain,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
  errGGovTopicIndexOOB,
  errGGovUnvotable,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingNotStarted,
  errPeriodAppNotConfigured,
  errPeriodEndLessThanStart,
  errPeriodInRange,
  errRegistryMissing,
  errUnauthorized,
} from '../base/errors.algo'
import { transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
import { configureTestLogging } from '../test-utils'

type ConfirmationLike = { logs?: Uint8Array[]; confirmedRound?: number | bigint }
type SendResultLike = { confirmations?: ConfirmationLike[]; confirmation?: ConfirmationLike }

async function deployRegistryAndSDK(
  localnet: ReturnType<typeof algorandFixture>,
  admin: Address,
  firstPeriodId?: bigint | number,
) {
  // GGovRegistrySDK.createRegistry() pays the registry MBR + box-MBR out of the deployer's balance; top
  // the localnet test admin up so it can afford the 10 ALGO transfer plus deploy fees.
  await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
  const { appClient } = await GGovRegistrySDK.createRegistry({
    algorand: localnet.algorand,
    deployer: {
      sender: admin,
      signer: localnet.algorand.account.getSigner(admin),
    },
    firstPeriodId,
  })
  // Combined SDK for period ops; registry ops go through sdk.registry.
  const sdk = new GGovSDK({
    algorand: localnet.algorand,
    registryAppId: appClient.appId,
    writerAccount: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
  })
  return { appClient, sdk }
}

/**
 * Deploy the registry app but skip the period approval bytecode upload. Used by the
 * "approval not configured" tests where we want createPeriod to fail at the box-exists guard.
 */
async function deployRegistryWithoutBytecode(localnet: ReturnType<typeof algorandFixture>, admin: Address) {
  const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: admin,
  })
  const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
  await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (10).algos())
  const sdk = new GGovSDK({
    algorand: localnet.algorand,
    registryAppId: appClient.appId,
    writerAccount: {
      sender: admin,
      signer: localnet.algorand.account.getSigner(admin),
    },
    debug: false,
  })
  return { appClient, sdk }
}

function createUserSDK(localnet: ReturnType<typeof algorandFixture>, appId: bigint, user: Address) {
  return new GGovSDK({
    algorand: localnet.algorand,
    registryAppId: appId,
    writerAccount: {
      sender: user,
      signer: localnet.algorand.account.getSigner(user),
    },
    debug: false,
  })
}

async function deployWithCommittee(
  localnet: ReturnType<typeof algorandFixture>,
  numGovs = 3,
  votesPerMember = 10,
  firstPeriodId?: bigint | number,
) {
  const { testAccount: admin } = localnet.context
  const { appClient, sdk } = await deployRegistryAndSDK(localnet, admin, firstPeriodId)

  const govAccounts = await Promise.all(
    Array.from({ length: numGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committeeFile: GGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: numGovs,
    totalVotes: numGovs * votesPerMember,
    registryId: 0,
    govs: govAccounts.map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }
  const committeeId = await sdk.registry.uploadCommitteeFile(committeeFile)

  return { appClient, sdk, committeeId, committeeFile, govAccounts, admin }
}

/** Create a period with topics ready for voting (votingStart in past, ready=true). */
async function createVotingPeriod(
  sdk: GGovSDK,
  committeeId: Uint8Array,
  topicOptionsList: string[][],
): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000))
  // Add period with future votingStart so we can add topics first
  const periodId = await sdk.registry.addPeriod({
    committeeId,
    votingStart: now + 10000n,
    votingEnd: now + 20000n,
  })
  for (const options of topicOptionsList) {
    await sdk.addTopic({ periodId, options })
  }
  // Move votingStart to the past (still editable because ready=false)
  await sdk.editPeriod({
    periodId,
    committeeId,
    votingStart: now - 600n,
    votingEnd: now + 3600n,
  })
  // Mark ready so voting is allowed
  await sdk.setReady({ periodId, ready: true })
  return periodId
}

describe('GGovPeriod contract', () => {
  const localnet = algorandFixture()
  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // ── setOperator ──────────────────────────────────────────────────

  describe('setOperator', () => {
    test('Admin can set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { sdk } = await deployRegistryAndSDK(localnet, admin)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.registry.setOperator({ account: operator.toString() })

      const state = await sdk.registry.getGlobalState()
      expect(state.operator).toBeDefined()
      expect(state.currentRound).toBeGreaterThan(0n)
    })

    test('Non-admin cannot set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployRegistryAndSDK(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)
      await expect(nonAdminSDK.registry.setOperator({ account: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  // ── deployment configuration ─────────────────────────────────────

  describe('deployment configuration', () => {
    // The registry creates each period app via an inner appcreate that hard-codes
    // extraProgramPages: 3 (PERIOD_EXTRA_PROGRAM_PAGES) so the period approval program
    // can grow to the AVM 8192-byte ceiling without ever requiring a registry redeploy.
    // Guard against that constant drifting on a contract change.
    test('period app is created with extraProgramPages=3', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 100n,
        votingEnd: now + 3700n,
      })

      const periodAppId = await sdk.getPeriodAppId(periodId)
      const appInfo = await localnet.algorand.app.getById(periodAppId)
      expect(appInfo.extraProgramPages).toBe(3)
    })
  })

  // ── addPeriod ────────────────────────────────────────────────────

  describe('addPeriod', () => {
    test('Operator can add a period; registry stores summary', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 100n,
        votingEnd: now + 3700n,
      })
      expect(periodId).toBe(1n)

      // Registry summary populated
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(BigInt(summary!.appId)).toBeGreaterThan(0n)
      expect(Number(summary!.votingStart)).toBeGreaterThan(0)
      expect(summary!.numTopics).toBe(0)

      // Period contract reports the same window via getPeriod
      const period = await sdk.getPeriod(periodId)
      expect(Number(period.votingStart)).toBeGreaterThan(0)
      expect(period.topics).toHaveLength(0)
    })

    test('Non-operator cannot add a period', async () => {
      const { sdk, committeeId } = await deployWithCommittee(localnet)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.registry.setOperator({ account: operator.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      // admin is NOT the operator
      await expect(
        sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Rejects votingEnd <= votingStart', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.registry.addPeriod({ committeeId, votingStart: now + 3700n, votingEnd: now + 100n }),
      ).rejects.toThrow(transformedError(errPeriodEndLessThanStart))
    })
  })

  // ── setLastPeriodId / contiguous period ids ───────────────────

  describe('setLastPeriodId / contiguous period ids', () => {
    test('firstPeriodId seeds the first period id (contiguous after a legacy system)', async () => {
      // Legacy system ran periods 1..15; new periods should continue at 16.
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 3, 10, 16n)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const id2 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      const id3 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 300n, votingEnd: now + 3900n })
      expect([id1, id2, id3]).toEqual([16n, 17n, 18n])

      // Reader enumerates from 1 but the phantom 1..15 are filtered (no boxes) — list starts at 16.
      const summaries = await sdk.registry.getAllPeriodSummaries()
      expect(summaries.map((s) => s.id)).toEqual([16n, 17n, 18n])
      for (const { summary } of summaries) {
        expect(BigInt(summary.appId)).toBeGreaterThan(0n)
      }
    })

    test('setLastPeriodId forward-seeds the counter; next period is newLastPeriodId + 1', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setLastPeriodId({ newLastPeriodId: 15n })
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      expect(periodId).toBe(16n)
    })

    test('Non-admin cannot rewind', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployRegistryAndSDK(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)
      await expect(nonAdminSDK.registry.setLastPeriodId({ newLastPeriodId: 15n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('Rewind refuses to re-issue an id that has a live period', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      expect(periodId).toBe(1n)
      // Rewinding to 0 would re-issue id 1, which is live → reject.
      await expect(sdk.registry.setLastPeriodId({ newLastPeriodId: 0n })).rejects.toThrow(
        transformedError(errPeriodInRange),
      )
    })

    test('Rewind allowed across a deleted period; the id is re-issued', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      expect(periodId).toBe(1n)
      // Deleting drops the summary box, so the id is free to re-issue.
      await sdk.deletePeriodApp({ periodId })
      await sdk.registry.setLastPeriodId({ newLastPeriodId: 0n })
      const reissued = await sdk.registry.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      expect(reissued).toBe(1n)
    })
  })

  // ── getAllPeriods / getAllPeriodSummaries ────────────────────────

  describe('getAllPeriods / getAllPeriodSummaries', () => {
    // Deleted-period filtering (summary.appId === 0) is exercised by the deletePeriodApp suite
    // below: deleting a period inner-calls registry.removePeriodSummary, dropping its summary box.

    test('Empty registry returns no periods', async () => {
      const { sdk } = await deployWithCommittee(localnet)
      expect(await sdk.registry.getAllPeriodSummaries()).toEqual([])
      expect(await sdk.getAllPeriods()).toEqual([])
    })

    test('Enumerates all periods in order with full data', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const id2 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      const id3 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 300n, votingEnd: now + 3900n })
      expect([id1, id2, id3]).toEqual([1n, 2n, 3n])
      // give period 2 two topics
      await sdk.addTopic({ periodId: id2, options: ['Yes', 'No', 'Abstain'] })
      await sdk.addTopic({ periodId: id2, options: ['A', 'B', 'C', 'Abstain'] })

      const summaries = await sdk.registry.getAllPeriodSummaries()
      expect(summaries.map((s) => s.id)).toEqual([1n, 2n, 3n])
      for (const { summary } of summaries) {
        expect(BigInt(summary.appId)).toBeGreaterThan(0n)
      }
      expect(summaries[0].summary.numTopics).toBe(0)
      expect(summaries[1].summary.numTopics).toBe(2)

      const periods = await sdk.getAllPeriods()
      expect(periods.map((p) => p.id)).toEqual([1n, 2n, 3n])
      expect(periods[1].period.topics).toHaveLength(2)
      for (const { period } of periods) {
        expect(Number(period.votingStart)).toBeGreaterThan(0)
        expect(Number(period.votingEnd)).toBeGreaterThan(Number(period.votingStart))
      }
    })

    test('ready flag round-trips through the summary', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      await sdk.registry.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      await sdk.setReady({ periodId: id1, ready: true })

      const summaries = await sdk.registry.getAllPeriodSummaries()
      const byId = new Map(summaries.map((s) => [s.id, s.summary]))
      expect(byId.get(1n)!.ready).toBe(true)
      expect(byId.get(2n)!.ready).toBe(false)
    })
  })

  // ── deletePeriodApp (admin-only, !ready) ─────────────────────────

  describe('deletePeriodApp', () => {
    test('Admin can delete a non-ready period; registry summary box is removed', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const id2 = await sdk.registry.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })

      // Sanity: both summaries present before deletion.
      expect((await sdk.registry.getAllPeriodSummaries()).map((s) => s.id)).toEqual([id1, id2])

      await sdk.deletePeriodApp({ periodId: id1 })

      // Summary box for id1 is gone (getPeriodSummary returns the empty/appId-0 summary)…
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId: id1 } })
      expect(BigInt(summary!.appId)).toBe(0n)

      // …and it drops out of the enumerations, leaving only id2.
      expect((await sdk.registry.getAllPeriodSummaries()).map((s) => s.id)).toEqual([id2])
      expect((await sdk.getAllPeriods()).map((p) => p.id)).toEqual([id2])
    })

    test('Cannot delete a ready period', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 100n,
        votingEnd: now + 3700n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.setReady({ periodId, ready: true })

      await expect(sdk.deletePeriodApp({ periodId })).rejects.toThrow(transformedError(errGGovReady))

      // Period survives the rejected deletion.
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(BigInt(summary!.appId)).toBeGreaterThan(0n)
    })

    test('Non-admin cannot delete a period', async () => {
      const { appClient, sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 100n,
        votingEnd: now + 3700n,
      })

      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)
      await expect(nonAdminSDK.deletePeriodApp({ periodId })).rejects.toThrow(transformedError(errUnauthorized))

      // Period survives the rejected deletion.
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(BigInt(summary!.appId)).toBeGreaterThan(0n)
    })

    test('Deletes every period box (paged) and reclaims their MBR to the admin', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      // Over-fund the period app so it can hold the period body + all topic-body box MBR.
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(periodAppId), (3).algos())

      // >8 topics each with an uploaded body, plus a period body → 'o','t','P' + 9×'T' = 12 boxes,
      // so topic-body cleanup spans multiple batches (>8 box refs per txn is impossible).
      const NUM_TOPICS = 9
      for (let i = 0; i < NUM_TOPICS; i++) {
        // Unique note per call so otherwise-identical addTopic txns get distinct txids.
        await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'], note: `addTopic-${i}` })
      }
      await sdk.uploadPeriodBody({ periodId, body: { title: 'Period', body: 'Period description body.' } })
      for (let i = 0; i < NUM_TOPICS; i++) {
        await sdk.uploadTopicBody({ periodId, topicIndex: i, body: { title: `Topic ${i}`, body: `Body ${i}.` } })
      }

      // Sanity: all boxes are present before deletion.
      expect((await localnet.algorand.app.getBoxNames(periodAppId)).length).toBe(3 + NUM_TOPICS)

      const adminBefore = (await localnet.algorand.client.algod.accountInformation(admin.toString()).do()).amount

      await sdk.deletePeriodApp({ periodId })

      // Every box is gone — none left to lock MBR.
      expect((await localnet.algorand.app.getBoxNames(periodAppId)).length).toBe(0)
      // Registry summary dropped.
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(BigInt(summary!.appId)).toBe(0n)
      // The swept app-account balance (base + all freed box MBR) lands with the admin, net of fees.
      const adminAfter = (await localnet.algorand.client.algod.accountInformation(admin.toString()).do()).amount
      expect(adminAfter).toBeGreaterThan(adminBefore)
    })
  })

  // ── uploadPeriodApprovalProgram + bytecode-configuration guard ───

  describe('period approval program', () => {
    test('createPeriod rejects when approval bytecode has not been uploaded', async () => {
      const { testAccount: admin } = localnet.context
      const { sdk } = await deployRegistryWithoutBytecode(localnet, admin)
      await sdk.registry.setOperator({ account: admin.toString() })

      // Register a committee so addPeriod gets past the committee checks.
      const govs = await Promise.all(
        Array.from({ length: 1 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: govs.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      const committeeId = await sdk.registry.uploadCommitteeFile(committeeFile)

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n }),
      ).rejects.toThrow(transformedError(errPeriodAppNotConfigured))
    })

    test('Non-admin cannot upload approval bytecode', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployRegistryWithoutBytecode(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)

      await expect(
        nonAdminSDK.registry.uploadPeriodApprovalProgram({ bytecode: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Admin re-upload replaces the prior bytecode (subsequent addPeriod uses fresh bytes)', async () => {
      // The fixture deployRegistryAndSDK already uploaded the canonical bytecode via GGovRegistrySDK.createRegistry.
      // Re-uploading must succeed (chunk 0 resets the box) and a subsequent addPeriod must still spawn.
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })

      // Re-upload the canonical bytecode. Box re-create must work (chunk 0 deletes the box first).
      // Use a unique note so the re-upload txns don't collide with the original upload (same payload
      // + same sender would otherwise produce a duplicate txn ID).
      const periodFactory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, {
        defaultSender: admin,
      })
      const compiled = await periodFactory.appFactory.compile()
      await sdk.registry.uploadPeriodApprovalProgram({ bytecode: compiled.approvalProgram, note: 're-upload' })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      expect(periodId).toBeGreaterThan(0n)
    })
  })

  // ── editPeriod + summary sync ────────────────────────────────────

  describe('editPeriod', () => {
    test('Operator can edit a future period; summary is synced back to registry', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      await sdk.editPeriod({
        periodId,
        committeeId,
        votingStart: now + 2000n,
        votingEnd: now + 6000n,
      })

      const period = await sdk.getPeriod(periodId)
      expect(BigInt(period.votingStart)).toBe(now + 2000n)

      // Registry summary reflects the edit
      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(BigInt(summary!.votingStart)).toBe(now + 2000n)
      expect(BigInt(summary!.votingEnd)).toBe(now + 6000n)
    })
  })

  // ── addTopic + numTopics sync ────────────────────────────────────

  describe('addTopic', () => {
    test('Operator can add topics; numTopics on registry summary tracks count', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const idx0 = await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      expect(idx0).toBe(0n)
      const summary1 = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary1.return!.numTopics).toBe(1)

      const idx1 = await sdk.addTopic({ periodId, options: ['A', 'B', 'Abstain'] })
      expect(idx1).toBe(1n)
      const summary2 = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary2.return!.numTopics).toBe(2)

      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(2)
    })

    test('Rejects empty options', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await expect(sdk.addTopic({ periodId, options: [] })).rejects.toThrow(transformedError(errGGovNoOptions))
    })

    test('Rejects a topic whose last option is not Abstain', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await expect(sdk.addTopic({ periodId, options: ['Yes', 'No'] })).rejects.toThrow(
        transformedError(errGGovLastOptionAbstain),
      )
    })
  })

  // ── addTopicWithBody (combined add + body upload) ─────────────────

  describe('addTopicWithBody', () => {
    test('Adds a topic and uploads its body in a single signed group', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      const body = { title: 'Topic title', body: 'Topic **body** in markdown.' }
      // A normal-sized body needs exactly one signature.
      expect(GGovSDK.addTopicWithBodyGroupCount(body)).toBe(1)

      const signed: number[] = []
      const idx = await sdk.addTopicWithBody({
        periodId,
        options: ['Yes', 'No', 'Abstain'],
        body,
        onSigningGroup: (i) => signed.push(i),
      })
      expect(idx).toBe(0n)
      expect(signed).toEqual([0]) // one group signed

      // Topic + registry summary reflect the add.
      const summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.numTopics).toBe(1)
      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(1)
      expect(period.topics[0][0]).toEqual(['Yes', 'No', 'Abstain'])

      // Body round-trips from the topic's body box.
      expect(await sdk.getTopicBody(periodId, idx)).toEqual(body)
    })

    test('Predicts the topic index from the current topic count', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      // A pre-existing (body-less) topic shifts the next index to 1.
      await sdk.addTopic({ periodId, options: ['A', 'B', 'Abstain'] })

      const body = { title: 'Second', body: 'Second topic body.' }
      const idx = await sdk.addTopicWithBody({ periodId, options: ['Yes', 'No', 'Abstain'], body })
      expect(idx).toBe(1n)

      // The body lands on topic 1; topic 0 (which never got a body) has none.
      expect(await sdk.getTopicBody(periodId, 1n)).toEqual(body)
      expect(await sdk.getTopicBody(periodId, 0n)).toBeNull()
      expect((await sdk.getPeriod(periodId)).topics).toHaveLength(2)
    })

    test('Rides the maximal single-group body (14 chunks) along with addTopic in one signature', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      // Over-fund the period app for the ~28 KB body box's min-balance (addTopic sends no MBR top-up).
      const periodAppId = await sdk.getPeriodAppId(periodId)
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(periodAppId), (16).algos())

      // ~27.7 KB serializes to exactly 14 × 2000-byte chunks — the most that still rides along with
      // addTopic in ONE group (ADD_TOPIC_FIRST_GROUP_BODY_CHUNKS = MAX_GROUP_SIZE - 2): addTopic + 14
      // partials + a reserved budget slot = 16 txns. Just over this tips into the two-signature path
      // (see the next test), so this exercises the boundary that constant is built around.
      const maxBody = { title: 'Max single-group body', body: 'x'.repeat(27_700) }
      expect(GGovSDK.addTopicWithBodyGroupCount(maxBody)).toBe(1)

      const signed: number[] = []
      const idx = await sdk.addTopicWithBody({
        periodId,
        options: ['Yes', 'No', 'Abstain'],
        body: maxBody,
        onSigningGroup: (i) => signed.push(i),
      })
      expect(idx).toBe(0n)
      expect(signed).toEqual([0]) // still a single signed group at the boundary

      // The full body round-trips intact from the topic's body box.
      expect(await sdk.getTopicBody(periodId, idx)).toEqual(maxBody)
    })

    test('Falls back to two signatures for a body too large to ride with addTopic, intact', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      // Over-fund the period app for the ~28 KB body box's min-balance (addTopic sends no MBR top-up).
      const periodAppId = await sdk.getPeriodAppId(periodId)
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(periodAppId), (16).algos())

      // >14 chunks (>28 KB) can't ride along with addTopic in one group — that single group can't
      // carry enough box references for the box's I/O budget — so it splits into addTopic + a full
      // uploadTopicBody group: two signatures.
      const big = { title: 'Big topic', body: 'x'.repeat(28_100) }
      expect(GGovSDK.addTopicWithBodyGroupCount(big)).toBe(2)

      const signed: number[] = []
      const idx = await sdk.addTopicWithBody({
        periodId,
        options: ['Yes', 'No', 'Abstain'],
        body: big,
        onSigningGroup: (i) => signed.push(i),
      })
      expect(idx).toBe(0n)
      expect(signed).toEqual([0, 1]) // addTopic group, then the body-upload group

      // The full body round-trips intact (uploaded in its own full-size group).
      expect(await sdk.getTopicBody(periodId, idx)).toEqual(big)
    })

    test('Uploads the maximum-allowed body (32000 bytes) via the two-signature fallback', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      // Over-fund the period app for the 32 KB body box's min-balance (addTopic sends no MBR top-up).
      const periodAppId = await sdk.getPeriodAppId(periodId)
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(periodAppId), (16).algos())

      // 31_970 + JSON wrapper = exactly 32_000 serialized bytes = MAX_BODY_BYTES = 16 chunks: the
      // largest body the SDK accepts. Too big for the 14-chunk ride-along, so it takes the
      // two-signature fallback (addTopic, then ONE full 16-chunk uploadTopicBody group) — groupCount 2.
      const maxBody = { title: 'Max body', body: 'x'.repeat(31_970) }
      expect(GGovSDK.addTopicWithBodyGroupCount(maxBody)).toBe(2)

      const signed: number[] = []
      const idx = await sdk.addTopicWithBody({
        periodId,
        options: ['Yes', 'No', 'Abstain'],
        body: maxBody,
        onSigningGroup: (i) => signed.push(i),
      })
      expect(idx).toBe(0n)
      expect(signed).toEqual([0, 1]) // addTopic, then the single full uploadTopicBody group

      // The full 32 KB body round-trips intact.
      expect(await sdk.getTopicBody(periodId, idx)).toEqual(maxBody)
    })

    test('Rejects a body larger than MAX_BODY_BYTES before sending anything', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n })

      // One byte over the 32_000-byte cap (32_003 serialized) — would need a second, under-provisioned
      // upload group, so the SDK refuses up front rather than failing mid-upload on the AVM I/O budget.
      const tooBig = { title: 'Over limit', body: 'x'.repeat(31_971) }

      // The static signature-count helper validates the same way, so callers (e.g. the UI) see it early.
      expect(() => GGovSDK.addTopicWithBodyGroupCount(tooBig)).toThrow(/maximum is 32000/)

      // The upload methods reject too, and nothing is created: the topic count stays 0.
      await expect(sdk.addTopicWithBody({ periodId, options: ['Yes', 'No', 'Abstain'], body: tooBig })).rejects.toThrow(
        /maximum is 32000/,
      )
      await expect(sdk.uploadPeriodBody({ periodId, body: tooBig })).rejects.toThrow(/maximum is 32000/)
      const summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.numTopics).toBe(0)
    })
  })

  // ── editTopic ────────────────────────────────────────────────────

  describe('editTopic', () => {
    test('Operator can edit a topic with no votes', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject', 'Abstain'] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][0]).toEqual(['Approve', 'Reject', 'Abstain'])
      expect(period.topics[0][1]).toEqual([0, 0, 0])
    })

    test('Rejects out-of-bounds topic index', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      // Index error wins over trailing Abstain as this check precedes the options' validation.
      await expect(sdk.editTopic({ periodId, topicIndex: 0n, options: ['Yes'] })).rejects.toThrow(
        transformedError(errGGovTopicIndexOOB),
      )
    })

    test('Rejects a topic whose last option is not Abstain', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await expect(sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject'] })).rejects.toThrow(
        transformedError(errGGovLastOptionAbstain),
      )
    })

    test('Cannot edit topic once period is marked ready', async () => {
      // createVotingPeriod sets ready=true at the end; ready blocks edits before the timestamp check
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      // Options are deliberately non-compliant: ensureEditable runs before ensureValidOptions.
      await expect(sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject'] })).rejects.toThrow(
        transformedError(errGGovReady),
      )
    })

    test('Edits are allowed when ready=false even after votingStart has passed', async () => {
      // Editability is gated purely on ready, not on the timestamp window.
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 10000n,
        votingEnd: now + 20000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      // Rewind votingStart into the past while still in draft (ready=false)
      await sdk.editPeriod({
        periodId,
        committeeId,
        votingStart: now - 600n,
        votingEnd: now + 3600n,
      })
      // Editing topics is still permitted because ready=false
      await sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject', 'Abstain'] })
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][0]).toEqual(['Approve', 'Reject', 'Abstain'])
    })
  })

  // ── Voting ───────────────────────────────────────────────────────

  describe('vote', () => {
    test('gov can vote on all topics', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 3, 10)
      await sdk.registry.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No', 'Abstain'],
        ['A', 'B', 'C', 'Abstain'],
      ])

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [
          [7, 3, 0],
          [4, 4, 2, 0],
        ],
      })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([7, 3, 0])
      expect(period.topics[1][1]).toEqual([4, 4, 2, 0])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(false)
      expect(record!.topicVotes[0]).toEqual([7, 3, 0])
      expect(record!.topicVotes[1]).toEqual([4, 4, 2, 0])
    })

    test('Multiple govs voting accumulates tallies', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 3, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      for (const [voter, votes] of [[govAccounts[0], [10, 0, 0]] as const, [govAccounts[1], [3, 7, 0]] as const]) {
        const voterSDK = createUserSDK(localnet, appClient.appId, voter)
        await voterSDK.vote({
          periodId,
          voterAccount: voter.toString(),
          topicVotes: [[...votes]],
        })
      }

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([13, 7, 0])
    })

    test('Vote update subtracts old and adds new', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2, 0]] })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[3, 7, 0]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([3, 7, 0])
    })

    test('Rejects vote before voting starts (ready but window not open)', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 9999n,
        votingEnd: now + 19999n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      // Mark ready so the ready gate passes; the timestamp gate is what we want to exercise here.
      await sdk.setReady({ periodId, ready: true })

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVotingNotStarted))
    })

    test('Rejects vote with wrong topic count', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No', 'Abstain'],
        ['A', 'B', 'Abstain'],
      ])
      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVoteMismatch))
    })

    test('Rejects vote with wrong power sum', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[5, 6, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVotePowerMismatch))
    })
  })

  // ── MBR self-funding ─────────────────────────────────────────────

  describe('MBR self-funding via registry vault', () => {
    // Acts as well as regression test for the AVM property the whole design rests on: that `box_create`
    // raises `min_balance` immediately but defers the balance check to the end of the outer transaction.

    // One topic of three options: S = 1 + 3, so the record is 5 + 4*S = 21 bytes over a 33-byte key
    // ('v' + address), and box MBR is 2500 + 400 * (key + value).
    const VOTE_RECORD_MBR = 2_500n + 400n * (33n + 21n)
    const MBR_TOP_UP = 5_000_000n
    const REQUEST_FEE = 1_000n

    /**
     * A committee, an operator, a ready single-topic period, and a vault funded well past one top-up.
     * `createPeriod` only forwards the 1 ALGO period MBR, so every period here starts with little
     * headroom — which is the point.
     */
    async function setupVoting(numGovs = 1) {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, numGovs, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const periodAddress = getApplicationAddress(periodAppId).toString()
      const registryAddress = appClient.appAddress.toString()
      await localnet.algorand.account.ensureFundedFromEnvironment(registryAddress, (10).algos())
      return { sdk, appClient, admin, govAccounts, periodId, periodAppId, periodAddress, registryAddress }
    }

    type VotingCtx = Awaited<ReturnType<typeof setupVoting>>

    const availableOf = async (address: string) => {
      const info = await localnet.algorand.account.getInformation(address)
      return info.balance.microAlgo - info.minBalance.microAlgo
    }

    const periodAvailable = (ctx: VotingCtx) => availableOf(ctx.periodAddress)
    const registryAvailable = (ctx: VotingCtx) => availableOf(ctx.registryAddress)

    /** Withdraw the period's available balance down to `leave` microALGO. */
    const drainPeriodTo = async (ctx: VotingCtx, leave: bigint) => {
      const available = await periodAvailable(ctx)
      await ctx.sdk.withdrawPeriodALGO({
        periodId: ctx.periodId,
        receiver: ctx.admin.toString(),
        amount: available - leave,
      })
      expect(await periodAvailable(ctx)).toBe(leave)
    }

    /** Inner transactions of the group's last app call (the vote); reference pads come before it. */
    const voteInnerTxnCount = (result: { confirmations?: { innerTxns?: unknown[] }[] }) => {
      const confirmations = result.confirmations ?? []
      return confirmations[confirmations.length - 1].innerTxns?.length ?? 0
    }

    test('a well-funded period never asks for a top-up', async () => {
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const voterSDK = createUserSDK(localnet, ctx.appClient.appId, voter)
      const registryBefore = await registryAvailable(ctx)
      const periodBefore = await periodAvailable(ctx)

      const result = await voterSDK.vote({
        periodId: ctx.periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      // 1 inner getGovVotingPower only.
      expect(voteInnerTxnCount(result)).toBe(1)
      expect(await registryAvailable(ctx)).toBe(registryBefore)
      expect(await periodAvailable(ctx)).toBe(periodBefore - VOTE_RECORD_MBR)
    })

    test('a period with not enough available balance requests an MBR top-up', async () => {
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const voterSDK = createUserSDK(localnet, ctx.appClient.appId, voter)
      const leftover = VOTE_RECORD_MBR / 3n // positive, well under the record's MBR
      await drainPeriodTo(ctx, leftover)
      const registryBefore = await registryAvailable(ctx)

      const result = await voterSDK.vote({
        periodId: ctx.periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      expect(voteInnerTxnCount(result)).toBe(2)
      expect(await registryAvailable(ctx)).toBe(registryBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await periodAvailable(ctx)).toBe(leftover + MBR_TOP_UP - REQUEST_FEE - VOTE_RECORD_MBR)
      // Record is successfully stored
      const record = await ctx.sdk.getVotingRecord(ctx.periodId, voter.toString())
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])
    })

    test('a period at zero available balance requests an MBR top-up', async () => {
      // This is the `balance === minBalance` case
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const voterSDK = createUserSDK(localnet, ctx.appClient.appId, voter)
      await drainPeriodTo(ctx, VOTE_RECORD_MBR)
      const registryBefore = await registryAvailable(ctx)

      const result = await voterSDK.vote({
        periodId: ctx.periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      expect(voteInnerTxnCount(result)).toBe(2)
      expect(await registryAvailable(ctx)).toBe(registryBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await periodAvailable(ctx)).toBe(MBR_TOP_UP - REQUEST_FEE)
      const record = await ctx.sdk.getVotingRecord(ctx.periodId, voter.toString())
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])
    })

    test('a delegated vote requests an MBR top-up too', async () => {
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createUserSDK(localnet, ctx.appClient.appId, voter).registry.setVotingAccount({
        votingAddress: delegatee.toString(),
      })
      const leftover = VOTE_RECORD_MBR / 3n
      await drainPeriodTo(ctx, leftover)
      const registryBefore = await registryAvailable(ctx)

      const result = await createUserSDK(localnet, ctx.appClient.appId, delegatee).vote({
        periodId: ctx.periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      // 3 = getDelegate + getGovVotingPower + requestMBR.
      expect(voteInnerTxnCount(result)).toBe(3)
      expect(await registryAvailable(ctx)).toBe(registryBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await periodAvailable(ctx)).toBe(leftover + MBR_TOP_UP - REQUEST_FEE - VOTE_RECORD_MBR)
      const record = await ctx.sdk.getVotingRecord(ctx.periodId, voter.toString())
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])
    })

    test('a re-vote costs no MBR: one microALGO of headroom carries it', async () => {
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const voterSDK = createUserSDK(localnet, ctx.appClient.appId, voter)
      await voterSDK.vote({ periodId: ctx.periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })
      await drainPeriodTo(ctx, 1n)

      const result = await voterSDK.vote({
        periodId: ctx.periodId,
        voterAccount: voter.toString(),
        topicVotes: [[0, 10, 0]],
      })

      expect(voteInnerTxnCount(result)).toBe(1)
      expect(await periodAvailable(ctx)).toBe(1n)
      const record = await ctx.sdk.getVotingRecord(ctx.periodId, voter.toString())
      expect(record!.topicVotes[0]).toEqual([0, 10, 0])
    })

    test('a drained registry fails the user-facing vote call', async () => {
      const ctx = await setupVoting()
      const voter = ctx.govAccounts[0]
      const voterSDK = createUserSDK(localnet, ctx.appClient.appId, voter)
      await drainPeriodTo(ctx, 3n)
      await ctx.sdk.registry.withdrawALGO({
        receiver: ctx.admin.toString(),
        amount: await registryAvailable(ctx),
      })

      await expect(
        voterSDK.vote({ periodId: ctx.periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] }),
      ).rejects.toThrow()
    })

    test('every vote references the registry app and its periods box, top-up or not', async () => {
      // The vote must name the registry's `periods` box unconditionally: checkNeedMBR reads it only
      // on a branch another voter's transaction can flip between simulate and execution, and resource
      // population resolves references BY simulating. Regression test: nothing else in this suite would
      // notice if the SDK stopped sending it.
      const ctx = await setupVoting(2)
      const [first, second] = ctx.govAccounts
      const firstSDK = createUserSDK(localnet, ctx.appClient.appId, first)
      const secondSDK = createUserSDK(localnet, ctx.appClient.appId, second)

      const vaultBeforeFirst = await registryAvailable(ctx)
      const voteNoTopUp = await firstSDK.vote({
        periodId: ctx.periodId,
        voterAccount: first.toString(),
        topicVotes: [[10, 0, 0]],
      })
      const vaultAfterFirst = await registryAvailable(ctx)
      await drainPeriodTo(ctx, VOTE_RECORD_MBR / 3n)
      const voteWithTopUp = await secondSDK.vote({
        periodId: ctx.periodId,
        voterAccount: second.toString(),
        topicVotes: [[0, 10, 0]],
      })

      expect(vaultAfterFirst).toBe(vaultBeforeFirst)
      expect(await registryAvailable(ctx)).toBe(vaultAfterFirst - MBR_TOP_UP - REQUEST_FEE)

      const registryAppId = ctx.appClient.appId
      // 'p' + big-endian uint32(periodId), matching BoxMap<Uint32, GGovPeriodSummary>({ keyPrefix: 'p' }).
      const expectedName = new Uint8Array(5)
      expectedName[0] = 0x70
      new DataView(expectedName.buffer).setUint32(1, Number(ctx.periodId))
      // The vote app call is the group's last txn; the reference pads come before it.
      const voteCall = (r: typeof voteNoTopUp) => r.transactions[r.transactions.length - 1]

      for (const result of [voteNoTopUp, voteWithTopUp]) {
        const { foreignApps, boxes } = voteCall(result).applicationCall!
        expect(foreignApps).toContain(registryAppId)
        expect(boxes!.some((b) => b.appIndex === registryAppId && Buffer.from(b.name).equals(expectedName))).toBe(true)
      }
      // The two MBR inner calls pay their own fees, so the voter pays the same either way.
      expect(voteCall(voteWithTopUp).fee).toBe(voteCall(voteNoTopUp).fee)
    })
  })

  // ── Delegation ───────────────────────────────────────────────────

  describe('delegation', () => {
    test('Account can delegate and delegatee can vote', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })

      const delegation = await sdk.registry.getDelegation(voter.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(delegatee.toString())

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(true)
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])
    })

    test('Delegated vote without the delegator account reference is rejected', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })

      // Call the period client directly so we can omit the account reference the SDK adds for
      // delegated votes. The contract must reject it (Txn.accounts[0] !== delegator).
      const appId = await sdk.getPeriodAppId(periodId)
      const rawClient = new GGovPeriodClient({
        algorand: localnet.algorand,
        appId,
        defaultSender: delegatee.toString(),
        defaultSigner: localnet.algorand.account.getSigner(delegatee),
      })
      await expect(
        rawClient.send.vote({
          args: { voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] },
          extraFee: (2000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errGGovDelegationNoAcctRef))
    })

    test('Random address (no gGov account) cannot set a voting account', async () => {
      const { appClient, govAccounts } = await deployWithCommittee(localnet)
      // a freshly generated account is not a committee member, so it has no gGov account
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const strangerSDK = createUserSDK(localnet, appClient.appId, stranger)
      await expect(strangerSDK.registry.setVotingAccount({ votingAddress: govAccounts[0].toString() })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
    })

    test('Can clear a delegation (undelegate)', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.registry.setVotingAccount({})
      const delegation = await sdk.registry.getDelegation(voter.toString())
      expect(delegation.exists).toBe(false)
    })

    test('Delegatee cannot override direct vote', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await expect(
        delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))

      // The rejected override must leave the voter's direct vote and the tallies untouched.
      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(false)
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([10, 0, 0])
    })

    test('Delegatee can override their own prior delegated vote', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2, 0]] })
      // Re-voting on behalf overrides the delegatee's own prior delegated vote (isDelegated stays true).
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[1, 9, 0]] })

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(true)
      expect(record!.topicVotes[0]).toEqual([1, 9, 0])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([1, 9, 0])
    })

    test('Voter override of a delegated vote flips the record and re-tallies', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })

      // Record is the delegated vote before the voter steps in.
      let record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(true)
      expect(record!.topicVotes[0]).toEqual([10, 0, 0])

      // Voter votes directly: isDelegated flips to false and the tally reflects only the new vote.
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10, 0]] })
      record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(false)
      expect(record!.topicVotes[0]).toEqual([0, 10, 0])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10, 0])
    })

    test('Voter can override delegatee vote', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10, 0]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10, 0])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.isDelegated).toBe(false)
    })
  })

  // ── Reverse delegation index ─────────────────────────────────────

  describe('reverse delegation index', () => {
    test('delegate records the delegator address under the delegatee', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })

      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([voter.toString()])
      // forward index stays consistent with the reverse index
      expect((await sdk.registry.getDelegation(voter.toString())).delegatee).toBe(delegatee.toString())
    })

    test('multiple delegators accumulate under one delegatee', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const [voterA, voterB] = govAccounts
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createUserSDK(localnet, appClient.appId, voterA).registry.setVotingAccount({
        votingAddress: delegatee.toString(),
      })
      await createUserSDK(localnet, appClient.appId, voterB).registry.setVotingAccount({
        votingAddress: delegatee.toString(),
      })

      // insertion order preserved (delegate-call order)
      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([voterA.toString(), voterB.toString()])
    })

    test('undelegate removes the delegator from the reverse index', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.registry.setVotingAccount({})

      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([])
    })

    test('undelegate leaves co-delegators of the same delegatee untouched', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const [voterA, voterB] = govAccounts
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterASDK = createUserSDK(localnet, appClient.appId, voterA)
      await voterASDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await createUserSDK(localnet, appClient.appId, voterB).registry.setVotingAccount({
        votingAddress: delegatee.toString(),
      })

      await voterASDK.registry.setVotingAccount({})

      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([voterB.toString()])
    })

    test('re-delegating moves the delegator between reverse lists', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegateeA = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const delegateeB = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.registry.setVotingAccount({ votingAddress: delegateeA.toString() })
      await voterSDK.registry.setVotingAccount({ votingAddress: delegateeB.toString() })

      expect(await sdk.registry.getDelegators(delegateeA.toString())).toEqual([])
      expect(await sdk.registry.getDelegators(delegateeB.toString())).toEqual([voter.toString()])
    })

    test('re-delegating to the same delegatee does not duplicate the entry', async () => {
      const { sdk, appClient, govAccounts } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })

      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([voter.toString()])
    })

    test('no delegations yields an empty reverse list', async () => {
      const { sdk } = await deployWithCommittee(localnet)
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      expect(await sdk.registry.getDelegators(delegatee.toString())).toEqual([])
    })
  })

  // ── Read methods ────────────────────────────────────────────────

  describe('read methods', () => {
    test('canVote returns true for eligible voter in active period', async () => {
      const { sdk, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const result = await sdk.canVote(periodId, govAccounts[0].toString(), govAccounts[0].toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })

    test('canVote is true for a delegatee while the voter has not voted', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createUserSDK(localnet, appClient.appId, voter).registry.setVotingAccount({
        votingAddress: delegatee.toString(),
      })

      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })

    // Regression: canVote must agree with vote()'s override guard. Previously canVote returned
    // true here even though vote() rejects with errGGovCannotOverride, so the delegatee was shown
    // as eligible but could not actually cast the vote.
    test('canVote is false for a delegatee once the voter has voted directly', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })

      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(false)
      expect(result.votingPower).toBe(0n)

      // The voter themselves can still vote (override their own direct vote).
      const self = await sdk.canVote(periodId, voter.toString(), voter.toString())
      expect(self.canVote).toBe(true)
    })

    test('canVote stays true for a delegatee overriding their own delegated vote', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      await createUserSDK(localnet, appClient.appId, delegatee).vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0, 0]],
      })

      // The existing record is a delegated vote (isDelegated=true), so the delegatee may re-vote.
      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })
  })

  // ── getPeriodShort ───────────────────────────────────────────────

  describe('getPeriodShort', () => {
    test('returns committee, voting window, and per-topic option counts', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No', 'Abstain'],
        ['A', 'B', 'C', 'D', 'Abstain'],
      ])

      const short = await sdk.getPeriodShort(periodId)
      expect(short.committeeId).toEqual(committeeId)
      // One entry per topic, holding that topic's option count — no options/votes payload.
      expect(short.topicOptionLengths).toEqual([3, 5])

      // The window agrees with what the full getPeriod read reports for the same period.
      const period = await sdk.getPeriod(periodId)
      expect(short.votingStart).toBe(period.votingStart)
      expect(short.votingEnd).toBe(period.votingEnd)
    })

    test('returns empty topic option counts for a period with no topics', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const short = await sdk.getPeriodShort(periodId)
      expect(short.committeeId).toEqual(committeeId)
      expect(short.topicOptionLengths).toEqual([])
      expect(short.votingStart).toBeGreaterThan(0)
      expect(short.votingEnd).toBeGreaterThan(0)
    })

    test('returns an empty shape for a period app that was never initialised', async () => {
      // A bare-created period app has registryApp still 0, so its global keys and topic boxes
      // don't exist yet. getPeriodShort must return the empty shape rather than assert, matching
      // getPeriod/logPeriod.
      const admin = localnet.context.testAccount
      const periodFactory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, { defaultSender: admin })
      const { appClient } = await periodFactory.send.create.bare()

      const { return: short } = await appClient.send.getPeriodShort({ args: {} })
      expect(short!.committeeId).toEqual(new Uint8Array(32))
      expect(short!.votingStart).toBe(0)
      expect(short!.votingEnd).toBe(0)
      expect(short!.topicOptionLengths).toEqual([])
    })
  })

  // ── Body uploads ────────────────────────────────────────────────

  describe('uploadPeriodBodyPartial', () => {
    test('Operator can upload period body in one chunk', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const bodyJson = new TextEncoder().encode('{"title":"Test","body":"A test."}')
      await sdk.uploadPeriodBodyPartial({
        periodId,
        startOffset: 0n,
        data: bodyJson,
      })
    })

    test('Cannot upload period body once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.setReady({ periodId, ready: true })
      const bodyJson = new TextEncoder().encode('{"title":"After ready"}')
      await expect(sdk.uploadPeriodBodyPartial({ periodId, startOffset: 0n, data: bodyJson })).rejects.toThrow(
        transformedError(errGGovReady),
      )
    })

    test('Cannot upload topic body once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.setReady({ periodId, ready: true })
      const bodyJson = new TextEncoder().encode('{"title":"Topic body"}')
      await expect(
        sdk.uploadTopicBodyPartial({
          periodId,
          topicIndex: 0n,
          startOffset: 0n,
          data: bodyJson,
        }),
      ).rejects.toThrow(transformedError(errGGovReady))
    })
  })

  // ── Trust boundary on summary updates ────────────────────────────

  describe('updatePeriodSummary trust boundary', () => {
    test('External writer cannot call updatePeriodSummary directly', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      // Direct call from the admin writer (not a period app) — caller_application_id will be 0
      // which does not match the registered period appId. Must reject with errUnauthorized.
      await expect(
        sdk.registry.writeClient!.send.updatePeriodSummary({
          args: {
            periodId,
            votingStart: 9999,
            votingEnd: 99999,
            numTopics: 42,
            ready: true,
          },
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })

  // ── setReady + ready gates ───────────────────────────────────────

  describe('setReady', () => {
    test('Operator can toggle ready; ready propagates to registry summary', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      let summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.ready).toBe(false)

      await sdk.setReady({ periodId, ready: true })
      summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.ready).toBe(true)

      await sdk.setReady({ periodId, ready: false })
      summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.ready).toBe(false)
    })

    test('Non-operator cannot setReady', async () => {
      const { sdk, appClient, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const nonOp = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonOpSDK = createUserSDK(localnet, appClient.appId, nonOp)
      await expect(nonOpSDK.setReady({ periodId, ready: true })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Cannot edit period once ready; can edit again after un-ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.setReady({ periodId, ready: true })

      // editPeriod is now blocked by errGGovReady
      await expect(
        sdk.editPeriod({
          periodId,
          committeeId,
          votingStart: now + 2000n,
          votingEnd: now + 6000n,
        }),
      ).rejects.toThrow(transformedError(errGGovReady))

      // addTopic is also blocked
      await expect(sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })).rejects.toThrow(
        transformedError(errGGovReady),
      )

      // Un-set ready → edits are allowed again
      await sdk.setReady({ periodId, ready: false })
      await sdk.editPeriod({
        periodId,
        committeeId,
        votingStart: now + 2000n,
        votingEnd: now + 6000n,
      })
    })

    test('setReady(false) succeeds when no votes have been cast', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])
      // No vote yet → un-ready is allowed
      await sdk.setReady({ periodId, ready: false })
      const summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.ready).toBe(false)
    })

    test('setReady(false) fails once any vote has been cast', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] })

      await expect(sdk.setReady({ periodId, ready: false })).rejects.toThrow(transformedError(errGGovHasVotes))
    })

    test('Cannot vote when period is not ready', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })

      // Set up a period with topics + past votingStart but DO NOT mark ready
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 10000n,
        votingEnd: now + 20000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.editPeriod({
        periodId,
        committeeId,
        votingStart: now - 600n,
        votingEnd: now + 3600n,
      })

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0, 0]] }),
      ).rejects.toThrow(transformedError(errGGovNotReady))
    })
  })

  // ── removeTopic ─────────────────────────────────────────────────

  describe('removeTopic', () => {
    test('Operator can remove a topic; numTopics summary tracks it', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['A', 'B', 'Abstain'] })
      await sdk.addTopic({ periodId, options: ['C', 'D', 'Abstain'] })
      await sdk.addTopic({ periodId, options: ['D', 'E', 'F', 'Abstain'] })

      // Remove the middle one (index 1)
      await sdk.removeTopic({ periodId, topicIndex: 1n })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(2)
      expect(period.topics[0][0]).toEqual(['A', 'B', 'Abstain'])
      expect(period.topics[1][0]).toEqual(['D', 'E', 'F', 'Abstain']) // index 2 → index 1 after removal

      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary!.numTopics).toBe(2)
    })

    test('Rejects out-of-bounds topic index', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await expect(sdk.removeTopic({ periodId, topicIndex: 0n })).rejects.toThrow(
        transformedError(errGGovTopicIndexOOB),
      )
    })

    test('Non-operator cannot removeTopic', async () => {
      const { sdk, appClient, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })

      const nonOp = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonOpSDK = createUserSDK(localnet, appClient.appId, nonOp)
      await expect(nonOpSDK.removeTopic({ periodId, topicIndex: 0n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('Cannot removeTopic once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      await sdk.setReady({ periodId, ready: true })

      await expect(sdk.removeTopic({ periodId, topicIndex: 0n })).rejects.toThrow(transformedError(errGGovReady))
    })
  })

  // ── update/delete period (admin resolved from registry global state) ─

  describe('updateApplication / deleteApplication', () => {
    const makePeriodClient = (localnet: ReturnType<typeof algorandFixture>, appId: bigint, sender: Address) =>
      new GGovPeriodClient({
        algorand: localnet.algorand,
        appId,
        defaultSender: sender,
        defaultSigner: localnet.algorand.account.getSigner(sender),
      })

    test('Registry admin can update a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, admin)
      await expect(client.send.update.bare({})).resolves.toBeDefined()
    })

    test('Non-admin cannot update a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, nonAdmin)
      await expect(client.send.update.bare({})).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('After admin rotation, new admin can update; old admin cannot', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)

      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.registry.setAdmin({ newAdmin: newAdmin.toString() })

      // Old admin (test creator) is no longer admin
      const oldClient = makePeriodClient(localnet, periodAppId, admin)
      await expect(oldClient.send.update.bare({})).rejects.toThrow(transformedError(errUnauthorized))

      // New admin can update
      const newClient = makePeriodClient(localnet, periodAppId, newAdmin)
      await expect(newClient.send.update.bare({})).resolves.toBeDefined()
    })

    test('Non-admin cannot delete a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, nonAdmin)
      await expect(client.send.delete.bare({})).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Registry admin can delete a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, admin)
      await expect(
        // deletes 'o'/'t'/'P' boxes (must be referenced); 1 inner removePeriodSummary + 1 inner sweep payment
        client.send.delete.bare({ boxReferences: ['o', 't', 'P'], extraFee: (2000).microAlgo() }),
      ).resolves.toBeDefined()
    })
  })

  // ── withdrawALGO (admin resolved from registry global state) ─────

  describe('withdrawALGO', () => {
    const makePeriodClient = (localnet: ReturnType<typeof algorandFixture>, appId: bigint, sender: Address) =>
      new GGovPeriodClient({
        algorand: localnet.algorand,
        appId,
        defaultSender: sender,
        defaultSigner: localnet.algorand.account.getSigner(sender),
      })

    /** Deploy a committee, set operator, and spawn a single period app. Returns the period app context. */
    async function deployWithPeriod(localnet: ReturnType<typeof algorandFixture>) {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.registry.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const periodAddress = makePeriodClient(localnet, periodAppId, admin).appAddress
      return { sdk, admin, periodId, periodAppId, periodAddress }
    }

    test('Registry admin can withdraw ALGO from a period app', async () => {
      const { sdk, periodId, periodAddress } = await deployWithPeriod(localnet)
      // createPeriod funds the period app ~1 ALGO MBR; top it up so there's a clear surplus.
      await localnet.algorand.account.ensureFundedFromEnvironment(periodAddress, (6).algos())
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const amount = (3).algos().microAlgo
      await sdk.withdrawPeriodALGO({ periodId, receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      // Receiver does not pay fees, so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
    })

    test('Non-admin cannot withdraw ALGO from a period app', async () => {
      const { sdk, periodId, periodAppId } = await deployWithPeriod(localnet)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonAdminSDK = createUserSDK(localnet, sdk.appId, nonAdmin)
      await expect(
        nonAdminSDK.withdrawPeriodALGO({ periodId, receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
      void periodAppId
    })

    test('Withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { sdk, periodId } = await deployWithPeriod(localnet)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        sdk.withdrawPeriodALGO({ periodId, receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })
  })

  // ── creator escape hatch ─────────────────────────────────────────
  describe('creator escape hatch', () => {
    test('the creator passes ensureCallerIsAdmin even when the registry admin is unresolvable', async () => {
      // Spin up a registry so its GGovSDK registers the ERR:-code error transformer on the shared
      // algorand client (used by the asserts below). Its state is otherwise irrelevant here.
      await deployWithCommittee(localnet)

      // Deploy a STANDALONE period app — not spawned by a registry, and `init` is never called — so
      // `registryApp` stays at the 0 sentinel and admin resolution has no registry global to read.
      // The deployer is the app's creator.
      const creator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const factory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, {
        defaultSender: creator,
        defaultSigner: localnet.algorand.account.getSigner(creator),
      })
      const { appClient } = await factory.send.create.bare({ extraProgramPages: 3 })

      // 0 sentinel: resolveAdmin() has nothing to read, so it would revert with ERR:RM.
      expect(BigInt((await appClient.state.global.registryApp())!)).toBe(0n)

      // Fund the app so a withdrawal has a surplus above its min balance.
      await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (5).algos())
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // A non-creator can't pass: the creator branch is skipped and resolveAdmin() reverts with ERR:RM.
      const nonCreator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        appClient.send.withdrawAlgo({
          args: { receiver: receiver.toString(), amount: (1).algos().microAlgo },
          sender: nonCreator,
          extraFee: (1000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errRegistryMissing))

      // The creator passes purely via the escape hatch (resolveAdmin would still revert with ERR:RM).
      const before = await localnet.algorand.account.getInformation(receiver)
      const amount = (1).algos().microAlgo
      await appClient.send.withdrawAlgo({
        args: { receiver: receiver.toString(), amount },
        extraFee: (1000).microAlgo(),
      })
      const after = await localnet.algorand.account.getInformation(receiver)
      // Receiver pays no fees, so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
    })
  })

  // ── Maximum number of topics ─────────────────────────────────────
  describe('maximum number of topics', () => {
    // A vote() must submit a vote row for *every* topic — the contract enforces
    // `topicVotes.length === numTopics` — and on every vote it emits the ARC-28 `GGovVoteCast`
    // event, which carries the full per-topic vote breakdown. A single application call may log at
    // most MaxLogSize = 1024 bytes, so the encoded event is the binding limit. The event is a
    // 4-byte ARC-28 prefix + ARC-4 (address,address,bool,uint64,uint32[][]): a 75-byte head
    // (32+32+1+8 + a 2-byte offset) + the topicVotes tail (2-byte array header + one row per
    // topic). With `k` options each row encodes to (4 + 4·k) bytes (2 offset + 2 length + k×uint32):
    //   4 + 75 + 2 + (4 + 4·k)·N ≤ 1024
    // k=2 (Yes/No) → N ≤ 78; k=3 (Yes/No/Abstain) → N ≤ 58. Verified with algosdk's encoder + on-chain.
    // Other ceilings sit higher, so they never bind: the vote's app args (MaxAppTotalArgLen = 2048)
    // allow 167 (2-option) topics, and the 32 KB box ceiling allows thousands to be *stored*. The
    // 1024-byte event log is what caps a *votable* period.
    //
    // setReady() recomputes this size up-front and refuses to ready a period whose vote event would
    // overflow, so an over-max period is rejected at ready time rather than discovered at vote time.

    /** Deploy a period carrying `numTopics` topics of `options`, funded for box MBR, window open. NOT readied. */
    async function buildPeriodWithTopics(
      sdk: GGovSDK,
      committeeId: Uint8Array,
      options: string[],
      numTopics: number,
    ): Promise<bigint> {
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.registry.addPeriod({
        committeeId,
        votingStart: now + 100000n,
        votingEnd: now + 200000n,
      })
      // addTopic sends no MBR top-up, so pre-fund the period app above the box MBR it will accrue.
      const appId = await sdk.getPeriodAppId(periodId)
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(appId), (12).algos())
      for (let i = 0; i < numTopics; i++) {
        // Unique note per call so otherwise-identical addTopic txns get distinct txids.
        await sdk.addTopic({ periodId, options, note: `addTopic-${i}` })
      }
      // Open the voting window (still editable because ready=false).
      await sdk.editPeriod({ periodId, committeeId, votingStart: now - 600n, votingEnd: now + 3600n })
      return periodId
    }

    /** A vote row that allocates all of the voter's power (10) to the first option. */
    const voteRow = (numOptions: number) => Array.from({ length: numOptions }, (_, i) => (i === 0 ? 10 : 0))

    describe.each([
      { label: 'Yes/Abstain (2 options)', options: ['Yes', 'Abstain'], max: 78 },
      { label: 'Yes/No/Abstain (3 options)', options: ['Yes', 'No', 'Abstain'], max: 58 },
    ])('$label', ({ options, max }) => {
      test(`a period at the maximum (${max}) topics can be readied and voted across all topics`, async () => {
        const { sdk, committeeId, govAccounts, appClient, admin } = await deployWithCommittee(localnet, 1, 10)
        await sdk.registry.setOperator({ account: admin.toString() })
        const periodId = await buildPeriodWithTopics(sdk, committeeId, options, max)
        // At the maximum, the vote event still fits in 1024 bytes, so setReady is allowed.
        await sdk.setReady({ periodId, ready: true })

        const voter = govAccounts[0] // voting power = votesPerMember = 10
        const voterSDK = createUserSDK(localnet, appClient.appId, voter)
        const row = voteRow(options.length) // sums to the voter's power (10)
        const topicVotes = Array.from({ length: max }, () => row)
        await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes })

        // Full record + tallies round-trip across all topics (reads use per-topic log lines via
        // simulate, which is not subject to the 1024-byte execution log limit).
        const record = await sdk.getVotingRecord(periodId, voter.toString())
        expect(record!.topicVotes.length).toBe(max)
        expect(record!.topicVotes[0]).toEqual(row)
        expect(record!.topicVotes[max - 1]).toEqual(row)

        const period = await sdk.getPeriod(periodId)
        expect(period.topics.length).toBe(max)
        expect(period.topics[0][1]).toEqual(row)
      }, 600_000)

      test(`a period with one over the maximum (${max + 1}) topics cannot be readied (vote event would exceed the 1024-byte log limit)`, async () => {
        const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
        await sdk.registry.setOperator({ account: admin.toString() })
        const periodId = await buildPeriodWithTopics(sdk, committeeId, options, max + 1)

        // setReady rejects up-front: the GGovVoteCast event for max+1 topics would exceed 1024
        // bytes, so this period could never be voted on. Caught here instead of at vote time.
        await expect(sdk.setReady({ periodId, ready: true })).rejects.toThrow(transformedError(errGGovUnvotable))
      }, 600_000)
    })
  })

  // ── ARC-28 events ────────────────────────────────────────────────
  describe('ARC-28 events', () => {
    // An ARC-28 event is logged as a 4-byte prefix — the first 4 bytes of sha512_256 of the event
    // signature `Name(type1,type2,...)` (note: no return type, unlike an ABI method selector) —
    // followed by the ARC-4-encoded args. We recompute that prefix and decode the matching log line.
    const eventSelector = (name: string, argTypes: string[]): Uint8Array =>
      Uint8Array.from(
        createHash('sha512-256')
          .update(`${name}(${argTypes.join(',')})`)
          .digest(),
      ).slice(0, 4)

    const collectLogs = (result: SendResultLike): Uint8Array[] => {
      const confs = result.confirmations ?? (result.confirmation ? [result.confirmation] : [])
      return confs.flatMap((c) => (c.logs ?? []) as Uint8Array[])
    }

    /** Find the single ARC-28 event of `name` in a send result and return its decoded args. */
    const decodeEvent = (result: SendResultLike, name: string, argTypes: string[]): ABIValue[] => {
      const selector = eventSelector(name, argTypes)
      const tuple = ABIType.from(`(${argTypes.join(',')})`)
      for (const logBytes of collectLogs(result)) {
        if (logBytes.length >= 4 && selector.every((b, i) => logBytes[i] === b)) {
          return tuple.decode(logBytes.slice(4)) as ABIValue[]
        }
      }
      throw new Error(`ARC-28 event ${name} not found in transaction logs`)
    }
    const addr = (v: ABIValue): string => (typeof v === 'string' ? v : encodeAddress(v as Uint8Array))

    const VOTE_CAST = ['address', 'address', 'bool', 'uint64', 'uint32[][]']
    const DELEGATION = ['address', 'address', 'address']

    test('vote() emits GGovVoteCast with the voter, sender, updateVote flag, power and votes', async () => {
      const { sdk, committeeId, govAccounts, appClient, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No', 'Abstain'],
        ['A', 'B', 'C', 'Abstain'],
      ])

      const voter = govAccounts[0] // self-vote: sender === voter, voting power 10
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      const first = await voterSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [
          [10, 0, 0],
          [10, 0, 0, 0],
        ],
      })
      const [evVoter, evSender, evUpdate, evPower, evVotes] = decodeEvent(first, 'GGovVoteCast', VOTE_CAST)
      expect(addr(evVoter)).toBe(voter.toString())
      expect(addr(evSender)).toBe(voter.toString())
      expect(evUpdate).toBe(false) // first vote → not an update
      expect(Number(evPower)).toBe(10)
      expect((evVotes as bigint[][]).map((r) => r.map(Number))).toEqual([
        [10, 0, 0],
        [10, 0, 0, 0],
      ])

      // Re-voting on the same record flips updateVote to true.
      const second = await voterSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [
          [0, 10, 0],
          [0, 10, 0, 0],
        ],
      })
      const [, , evUpdate2, , evVotes2] = decodeEvent(second, 'GGovVoteCast', VOTE_CAST)
      expect(evUpdate2).toBe(true)
      expect((evVotes2 as bigint[][]).map((r) => r.map(Number))).toEqual([
        [0, 10, 0],
        [0, 10, 0, 0],
      ])
    })

    test('setVotingAccount() emits GGovDelegationSet on delegate and re-delegate', async () => {
      const { govAccounts, appClient } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee1 = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const delegatee2 = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      const set = await voterSDK.registry.setVotingAccount({ votingAddress: delegatee1.toString() })
      const [d, prev, to] = decodeEvent(set, 'GGovDelegationSet', DELEGATION)
      expect(addr(d)).toBe(voter.toString())
      expect(addr(prev)).toBe(encodeAddress(new Uint8Array(32))) // zero address: no prior delegation
      expect(addr(to)).toBe(delegatee1.toString())

      // Re-delegating carries the previous delegatee.
      const redirect = await voterSDK.registry.setVotingAccount({ votingAddress: delegatee2.toString() })
      const [d2, prev2, to2] = decodeEvent(redirect, 'GGovDelegationSet', DELEGATION)
      expect(addr(d2)).toBe(voter.toString())
      expect(addr(prev2)).toBe(delegatee1.toString())
      expect(addr(to2)).toBe(delegatee2.toString())
    })

    test('setVotingAccount() (clear) emits GGovDelegationCleared with the previous delegatee', async () => {
      const { govAccounts, appClient } = await deployWithCommittee(localnet)
      const voter = govAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.registry.setVotingAccount({ votingAddress: delegatee.toString() })
      // Clearing (vote-for-self) removes the delegation.
      const cleared = await voterSDK.registry.setVotingAccount({})
      const [d, prev] = decodeEvent(cleared, 'GGovDelegationCleared', ['address', 'address'])
      expect(addr(d)).toBe(voter.toString())
      expect(addr(prev)).toBe(delegatee.toString())
    })
  })

  // ── firstVotingRound / lastVotingRound global state ───────────────
  describe('voting rounds (firstVotingRound / lastVotingRound)', () => {
    // vote() records the round of the *first* vote (written once, when firstVotingRound is still 0)
    // and the round of the *most recent* vote (rewritten every call) into the period's global state,
    // so an indexer can range-scan exactly the blocks in which voting happened. Both keys are
    // initialised to 0 at creation and stay 0 until the first vote writes them (round is never 0).

    /** Confirmed round of a send result's transaction group (every txn in the group shares it). */
    const confirmedRound = (result: SendResultLike): bigint => {
      const confs = result.confirmations ?? (result.confirmation ? [result.confirmation] : [])
      return BigInt(confs[confs.length - 1].confirmedRound!)
    }

    test('both rounds are 0 before any vote', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const g = await sdk.getPeriodGlobalState(periodId)
      expect(g.firstVotingRound).toBe(0n)
      expect(g.lastVotingRound).toBe(0n)
      // currentRound reflects the live network round (always past genesis here).
      expect(g.currentRound).toBeGreaterThan(0n)
    })

    test('first vote sets both rounds; a later voter advances only lastVotingRound', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 2, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      // First vote → firstVotingRound and lastVotingRound both set to this round.
      const voter0 = govAccounts[0]
      const sdk0 = createUserSDK(localnet, appClient.appId, voter0)
      const r0 = confirmedRound(
        await sdk0.vote({ periodId, voterAccount: voter0.toString(), topicVotes: [[10, 0, 0]] }),
      )

      const afterFirst = await sdk.getPeriodGlobalState(periodId)
      expect(afterFirst.firstVotingRound).toBe(r0)
      expect(afterFirst.lastVotingRound).toBe(r0)

      // A second voter in a later block advances lastVotingRound but leaves firstVotingRound put.
      const voter1 = govAccounts[1]
      const sdk1 = createUserSDK(localnet, appClient.appId, voter1)
      const r1 = confirmedRound(
        await sdk1.vote({ periodId, voterAccount: voter1.toString(), topicVotes: [[0, 10, 0]] }),
      )
      expect(r1).toBeGreaterThan(r0)

      const afterSecond = await sdk.getPeriodGlobalState(periodId)
      expect(afterSecond.firstVotingRound).toBe(r0) // unchanged by later votes
      expect(afterSecond.lastVotingRound).toBe(r1) // tracks the most recent vote
      // currentRound is read live, so it's at least the round of the latest vote.
      expect(afterSecond.currentRound).toBeGreaterThanOrEqual(r1)
    })

    test('a re-vote by the same account advances only lastVotingRound', async () => {
      const { sdk, appClient, committeeId, govAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.registry.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No', 'Abstain']])

      const voter = govAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      const r0 = confirmedRound(
        await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2, 0]] }),
      )
      const r1 = confirmedRound(
        await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[3, 7, 0]] }),
      )
      expect(r1).toBeGreaterThan(r0)

      const g = await sdk.getPeriodGlobalState(periodId)
      expect(g.firstVotingRound).toBe(r0)
      expect(g.lastVotingRound).toBe(r1)
    })
  })
})
