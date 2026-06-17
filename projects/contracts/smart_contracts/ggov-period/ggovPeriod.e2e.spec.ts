import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovSDK, GGovRegistryFactory, GGovPeriodFactory, GGovPeriodClient } from 'ggov-sdk'
import { XGovCommitteeFile } from 'ggov-sdk'
import {
  errAccountNotExists,
  errGGovCannotOverride,
  errGGovDelegationNoAcctRef,
  errGGovHasVotes,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
  errGGovTopicIndexOOB,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingNotStarted,
  errNotOperator,
  errPeriodAppNotConfigured,
  errPeriodEndLessThanStart,
  errUnauthorized,
} from '../base/errors.algo'
import { transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'

async function deployRegistryAndSDK(localnet: ReturnType<typeof algorandFixture>, admin: Address) {
  // GGovSDK.createRegistry() pays the registry MBR + box-MBR out of the deployer's balance; top
  // the localnet test admin up so it can afford the 10 ALGO transfer plus deploy fees.
  await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
  const { sdk, appClient } = await GGovSDK.createRegistry({
    algorand: localnet.algorand,
    deployer: {
      sender: admin,
      signer: localnet.algorand.account.getSigner(admin),
    },
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
  numXGovs = 3,
  votesPerMember = 10,
) {
  const { testAccount: admin } = localnet.context
  const { appClient, sdk } = await deployRegistryAndSDK(localnet, admin)

  const xGovAccounts = await Promise.all(
    Array.from({ length: numXGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committeeFile: XGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: numXGovs,
    totalVotes: numXGovs * votesPerMember,
    registryId: 0,
    xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)

  return { appClient, sdk, committeeId, committeeFile, xGovAccounts, admin }
}

/** Create a period with topics ready for voting (votingStart in past, ready=true). */
async function createVotingPeriod(
  sdk: GGovSDK,
  committeeId: Uint8Array,
  topicOptionsList: string[][],
): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000))
  // Add period with future votingStart so we can add topics first
  const periodId = await sdk.addPeriod({
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
  beforeAll(() => {
    Config.configure({ debug: true })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  // ── setOperator ──────────────────────────────────────────────────

  describe('setOperator', () => {
    test('Admin can set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { sdk } = await deployRegistryAndSDK(localnet, admin)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })

      const state = await sdk.registryWriteClient!.state.global.getAll()
      expect(state.operator).toBeDefined()
    })

    test('Non-admin cannot set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployRegistryAndSDK(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)
      await expect(nonAdminSDK.setOperator({ account: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  // ── addPeriod ────────────────────────────────────────────────────

  describe('addPeriod', () => {
    test('Operator can add a period; registry stores summary', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      // admin is NOT the operator
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Rejects votingEnd <= votingStart', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 3700n, votingEnd: now + 100n }),
      ).rejects.toThrow(transformedError(errPeriodEndLessThanStart))
    })
  })

  // ── getAllPeriods / getAllPeriodSummaries ────────────────────────

  describe('getAllPeriods / getAllPeriodSummaries', () => {
    // NOTE: deleted-period filtering (summary.appId === 0) is currently a no-op — the registry
    // has no deletePeriod, so summary boxes are never removed and there is no way to produce an
    // appId === 0 summary for an existing ID. Left untested until the registry-cleanup TODO lands
    // (see GGovPeriodContract.deleteApplication).

    test('Empty registry returns no periods', async () => {
      const { sdk } = await deployWithCommittee(localnet)
      expect(await sdk.getAllPeriodSummaries()).toEqual([])
      expect(await sdk.getAllPeriods()).toEqual([])
    })

    test('Enumerates all periods in order with full data', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const id2 = await sdk.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      const id3 = await sdk.addPeriod({ committeeId, votingStart: now + 300n, votingEnd: now + 3900n })
      expect([id1, id2, id3]).toEqual([1n, 2n, 3n])
      // give period 2 two topics
      await sdk.addTopic({ periodId: id2, options: ['Yes', 'No'] })
      await sdk.addTopic({ periodId: id2, options: ['A', 'B', 'C'] })

      const summaries = await sdk.getAllPeriodSummaries()
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
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const id1 = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      await sdk.addPeriod({ committeeId, votingStart: now + 200n, votingEnd: now + 3800n })
      await sdk.setReady({ periodId: id1, ready: true })

      const summaries = await sdk.getAllPeriodSummaries()
      const byId = new Map(summaries.map((s) => [s.id, s.summary]))
      expect(byId.get(1n)!.ready).toBe(true)
      expect(byId.get(2n)!.ready).toBe(false)
    })
  })

  // ── uploadPeriodApprovalProgram + bytecode-configuration guard ───

  describe('period approval program', () => {
    test('createPeriod rejects when approval bytecode has not been uploaded', async () => {
      const { testAccount: admin } = localnet.context
      const { sdk } = await deployRegistryWithoutBytecode(localnet, admin)
      await sdk.setOperator({ account: admin.toString() })

      // Register a committee so addPeriod gets past the committee checks.
      const xGovs = await Promise.all(
        Array.from({ length: 1 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        xGovs: xGovs.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 1000n, votingEnd: now + 5000n }),
      ).rejects.toThrow(transformedError(errPeriodAppNotConfigured))
    })

    test('Non-admin cannot upload approval bytecode', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployRegistryWithoutBytecode(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)

      await expect(
        nonAdminSDK.uploadPeriodApprovalProgram({ bytecode: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Admin re-upload replaces the prior bytecode (subsequent addPeriod uses fresh bytes)', async () => {
      // The fixture deployRegistryAndSDK already uploaded the canonical bytecode via GGovSDK.createRegistry.
      // Re-uploading must succeed (chunk 0 resets the box) and a subsequent addPeriod must still spawn.
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      // Re-upload the canonical bytecode. Box re-create must work (chunk 0 deletes the box first).
      // Use a unique note so the re-upload txns don't collide with the original upload (same payload
      // + same sender would otherwise produce a duplicate txn ID).
      const periodFactory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, {
        defaultSender: admin,
      })
      const compiled = await periodFactory.appFactory.compile()
      await sdk.uploadPeriodApprovalProgram({ bytecode: compiled.approvalProgram, note: 're-upload' })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const idx0 = await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      expect(idx0).toBe(0n)
      const summary1 = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary1.return!.numTopics).toBe(1)

      const idx1 = await sdk.addTopic({ periodId, options: ['A', 'B'] })
      expect(idx1).toBe(1n)
      const summary2 = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary2.return!.numTopics).toBe(2)

      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(2)
    })

    test('Rejects empty options', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await expect(sdk.addTopic({ periodId, options: [] })).rejects.toThrow(transformedError(errGGovNoOptions))
    })
  })

  // ── editTopic ────────────────────────────────────────────────────

  describe('editTopic', () => {
    test('Operator can edit a topic with no votes', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      await sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject', 'Abstain'] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][0]).toEqual(['Approve', 'Reject', 'Abstain'])
      expect(period.topics[0][1]).toEqual([0, 0, 0])
    })

    test('Rejects out-of-bounds topic index', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await expect(sdk.editTopic({ periodId, topicIndex: 0n, options: ['Yes'] })).rejects.toThrow(
        transformedError(errGGovTopicIndexOOB),
      )
    })

    test('Cannot edit topic once period is marked ready', async () => {
      // createVotingPeriod sets ready=true at the end; ready blocks edits before the timestamp check
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      await expect(
        sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject'] }),
      ).rejects.toThrow(transformedError(errGGovReady))
    })

    test('Edits are allowed when ready=false even after votingStart has passed', async () => {
      // Editability is gated purely on ready, not on the timestamp window.
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 10000n,
        votingEnd: now + 20000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
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
    test('xGov can vote on all topics', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 3, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No'],
        ['A', 'B', 'C'],
      ])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [
          [7, 3],
          [4, 4, 2],
        ],
      })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([7, 3])
      expect(period.topics[1][1]).toEqual([4, 4, 2])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(false)
      expect(record!.topicVotes[0]).toEqual([7, 3])
      expect(record!.topicVotes[1]).toEqual([4, 4, 2])
    })

    test('Multiple xGovs voting accumulates tallies', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 3, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      for (const [voter, votes] of [
        [xGovAccounts[0], [10, 0]] as const,
        [xGovAccounts[1], [3, 7]] as const,
      ]) {
        const voterSDK = createUserSDK(localnet, appClient.appId, voter)
        await voterSDK.vote({
          periodId,
          voterAccount: voter.toString(),
          topicVotes: [[...votes]],
        })
      }

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([13, 7])
    })

    test('Vote update subtracts old and adds new', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2]] })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[3, 7]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([3, 7])
    })

    test('Rejects vote before voting starts (ready but window not open)', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 9999n,
        votingEnd: now + 19999n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      // Mark ready so the ready gate passes; the timestamp gate is what we want to exercise here.
      await sdk.setReady({ periodId, ready: true })

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVotingNotStarted))
    })

    test('Rejects vote with wrong topic count', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No'],
        ['A', 'B'],
      ])
      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVoteMismatch))
    })

    test('Rejects vote with wrong power sum', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[5, 6]] }),
      ).rejects.toThrow(transformedError(errGGovVotePowerMismatch))
    })
  })

  // ── Delegation ───────────────────────────────────────────────────

  describe('delegation', () => {
    test('Account can delegate and delegatee can vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })

      const delegation = await sdk.getDelegation(voter.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(delegatee.toString())

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0]],
      })

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(true)
      expect(record!.topicVotes[0]).toEqual([10, 0])
    })

    test('Delegated vote without the delegator account reference is rejected', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })

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
          args: { voterAccount: voter.toString(), topicVotes: [[10, 0]] },
          extraFee: (2000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errGGovDelegationNoAcctRef))
    })

    test('Random address (no gGov account) cannot set a voting account', async () => {
      const { appClient, xGovAccounts } = await deployWithCommittee(localnet)
      // a freshly generated account is not a committee member, so it has no gGov account
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const strangerSDK = createUserSDK(localnet, appClient.appId, stranger)
      await expect(strangerSDK.setVotingAccount({ votingAddress: xGovAccounts[0].toString() })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
    })

    test('Can clear a delegation (undelegate)', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.setVotingAccount({})
      const delegation = await sdk.getDelegation(voter.toString())
      expect(delegation.exists).toBe(false)
    })

    test('Delegatee cannot override direct vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await expect(
        delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))

      // The rejected override must leave the voter's direct vote and the tallies untouched.
      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(false)
      expect(record!.topicVotes[0]).toEqual([10, 0])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([10, 0])
    })

    test('Delegatee can override their own prior delegated vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2]] })
      // Re-voting on behalf overrides the delegatee's own prior delegated vote (byDelegator stays true).
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[1, 9]] })

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(true)
      expect(record!.topicVotes[0]).toEqual([1, 9])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([1, 9])
    })

    test('Voter override of a delegated vote flips the record and re-tallies', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      // Record is the delegated vote before the voter steps in.
      let record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(true)
      expect(record!.topicVotes[0]).toEqual([10, 0])

      // Voter votes directly: byDelegator flips to false and the tally reflects only the new vote.
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] })
      record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(false)
      expect(record!.topicVotes[0]).toEqual([0, 10])
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10])
    })

    test('Voter can override delegatee vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(false)
    })
  })

  // ── Reverse delegation index ─────────────────────────────────────

  describe('reverse delegation index', () => {
    test('delegate records the delegator address under the delegatee', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })

      expect(await sdk.getDelegators(delegatee.toString())).toEqual([voter.toString()])
      // forward index stays consistent with the reverse index
      expect((await sdk.getDelegation(voter.toString())).delegatee).toBe(delegatee.toString())
    })

    test('multiple delegators accumulate under one delegatee', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const [voterA, voterB] = xGovAccounts
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createUserSDK(localnet, appClient.appId, voterA).setVotingAccount({ votingAddress: delegatee.toString() })
      await createUserSDK(localnet, appClient.appId, voterB).setVotingAccount({ votingAddress: delegatee.toString() })

      // insertion order preserved (delegate-call order)
      expect(await sdk.getDelegators(delegatee.toString())).toEqual([voterA.toString(), voterB.toString()])
    })

    test('undelegate removes the delegator from the reverse index', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.setVotingAccount({})

      expect(await sdk.getDelegators(delegatee.toString())).toEqual([])
    })

    test('undelegate leaves co-delegators of the same delegatee untouched', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const [voterA, voterB] = xGovAccounts
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterASDK = createUserSDK(localnet, appClient.appId, voterA)
      await voterASDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await createUserSDK(localnet, appClient.appId, voterB).setVotingAccount({ votingAddress: delegatee.toString() })

      await voterASDK.setVotingAccount({})

      expect(await sdk.getDelegators(delegatee.toString())).toEqual([voterB.toString()])
    })

    test('re-delegating moves the delegator between reverse lists', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegateeA = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const delegateeB = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.setVotingAccount({ votingAddress: delegateeA.toString() })
      await voterSDK.setVotingAccount({ votingAddress: delegateeB.toString() })

      expect(await sdk.getDelegators(delegateeA.toString())).toEqual([])
      expect(await sdk.getDelegators(delegateeB.toString())).toEqual([voter.toString()])
    })

    test('re-delegating to the same delegatee does not duplicate the entry', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })

      expect(await sdk.getDelegators(delegatee.toString())).toEqual([voter.toString()])
    })

    test('no delegations yields an empty reverse list', async () => {
      const { sdk } = await deployWithCommittee(localnet)
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      expect(await sdk.getDelegators(delegatee.toString())).toEqual([])
    })
  })

  // ── Read methods ────────────────────────────────────────────────

  describe('read methods', () => {
    test('canVote returns true for eligible voter in active period', async () => {
      const { sdk, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const result = await sdk.canVote(periodId, xGovAccounts[0].toString(), xGovAccounts[0].toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })

    test('canVote is true for a delegatee while the voter has not voted', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createUserSDK(localnet, appClient.appId, voter).setVotingAccount({ votingAddress: delegatee.toString() })

      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })

    // Regression: canVote must agree with vote()'s override guard. Previously canVote returned
    // true here even though vote() rejects with errGGovCannotOverride, so the delegatee was shown
    // as eligible but could not actually cast the vote.
    test('canVote is false for a delegatee once the voter has voted directly', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(false)
      expect(result.votingPower).toBe(0n)

      // The voter themselves can still vote (override their own direct vote).
      const self = await sdk.canVote(periodId, voter.toString(), voter.toString())
      expect(self.canVote).toBe(true)
    })

    test('canVote stays true for a delegatee overriding their own delegated vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.setVotingAccount({ votingAddress: delegatee.toString() })
      await createUserSDK(localnet, appClient.appId, delegatee).vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0]],
      })

      // The existing record is a delegated vote (byDelegator=true), so the delegatee may re-vote.
      const result = await sdk.canVote(periodId, voter.toString(), delegatee.toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })
  })

  // ── Body uploads ────────────────────────────────────────────────

  describe('uploadPeriodBodyPartial', () => {
    test('Operator can upload period body in one chunk', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const bodyJson = new TextEncoder().encode('{"title":"Test","body":"A test."}')
      await sdk.uploadPeriodBodyPartial({
        periodId,
        startOffset: 0n,
        data: bodyJson,
        last: true,
      })
    })

    test('Cannot upload period body once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      await sdk.setReady({ periodId, ready: true })
      const bodyJson = new TextEncoder().encode('{"title":"After ready"}')
      await expect(
        sdk.uploadPeriodBodyPartial({ periodId, startOffset: 0n, data: bodyJson, last: true }),
      ).rejects.toThrow(transformedError(errGGovReady))
    })

    test('Cannot upload topic body once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      await sdk.setReady({ periodId, ready: true })
      const bodyJson = new TextEncoder().encode('{"title":"Topic body"}')
      await expect(
        sdk.uploadTopicBodyPartial({
          periodId,
          topicIndex: 0n,
          startOffset: 0n,
          data: bodyJson,
          last: true,
        }),
      ).rejects.toThrow(transformedError(errGGovReady))
    })
  })

  // ── Trust boundary on summary updates ────────────────────────────

  describe('updatePeriodSummary trust boundary', () => {
    test('External writer cannot call updatePeriodSummary directly', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      // Direct call from the admin writer (not a period app) — caller_application_id will be 0
      // which does not match the registered period appId. Must reject with errUnauthorized.
      await expect(
        sdk.registryWriteClient!.send.updatePeriodSummary({
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
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const nonOp = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonOpSDK = createUserSDK(localnet, appClient.appId, nonOp)
      await expect(nonOpSDK.setReady({ periodId, ready: true })).rejects.toThrow(
        transformedError(errNotOperator),
      )
    })

    test('Cannot edit period once ready; can edit again after un-ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      await expect(sdk.addTopic({ periodId, options: ['Yes', 'No'] })).rejects.toThrow(
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
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      // No vote yet → un-ready is allowed
      await sdk.setReady({ periodId, ready: false })
      const summary = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary.return!.ready).toBe(false)
    })

    test('setReady(false) fails once any vote has been cast', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      await expect(sdk.setReady({ periodId, ready: false })).rejects.toThrow(
        transformedError(errGGovHasVotes),
      )
    })

    test('Cannot vote when period is not ready', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      // Set up a period with topics + past votingStart but DO NOT mark ready
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 10000n,
        votingEnd: now + 20000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      await sdk.editPeriod({
        periodId,
        committeeId,
        votingStart: now - 600n,
        votingEnd: now + 3600n,
      })

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovNotReady))
    })
  })

  // ── removeTopic ─────────────────────────────────────────────────

  describe('removeTopic', () => {
    test('Operator can remove a topic; numTopics summary tracks it', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['A', 'B'] })
      await sdk.addTopic({ periodId, options: ['C', 'D', 'E'] })
      await sdk.addTopic({ periodId, options: ['F'] })

      // Remove the middle one (index 1)
      await sdk.removeTopic({ periodId, topicIndex: 1n })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(2)
      expect(period.topics[0][0]).toEqual(['A', 'B'])
      expect(period.topics[1][0]).toEqual(['F']) // index 2 → index 1 after removal

      const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary!.numTopics).toBe(2)
    })

    test('Rejects out-of-bounds topic index', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })

      const nonOp = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const nonOpSDK = createUserSDK(localnet, appClient.appId, nonOp)
      await expect(nonOpSDK.removeTopic({ periodId, topicIndex: 0n })).rejects.toThrow(
        transformedError(errNotOperator),
      )
    })

    test('Cannot removeTopic once period is ready', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })
      await sdk.setReady({ periodId, ready: true })

      await expect(sdk.removeTopic({ periodId, topicIndex: 0n })).rejects.toThrow(
        transformedError(errGGovReady),
      )
    })
  })

  // ── update/delete period (admin via registry c2c) ────────────────

  describe('updateApplication / deleteApplication', () => {
    const makePeriodClient = (
      localnet: ReturnType<typeof algorandFixture>,
      appId: bigint,
      sender: Address,
    ) =>
      new GGovPeriodClient({
        algorand: localnet.algorand,
        appId,
        defaultSender: sender,
        defaultSigner: localnet.algorand.account.getSigner(sender),
      })

    test('Registry admin can update a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, admin)
      await expect(
        client.send.update.bare({ extraFee: (1000).microAlgo() }),
      ).resolves.toBeDefined()
    })

    test('Non-admin cannot update a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, nonAdmin)
      await expect(
        client.send.update.bare({ extraFee: (1000).microAlgo() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('After admin rotation, new admin can update; old admin cannot', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)

      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setAdmin({ newAdmin: newAdmin.toString() })

      // Old admin (test creator) is no longer admin
      const oldClient = makePeriodClient(localnet, periodAppId, admin)
      await expect(
        oldClient.send.update.bare({ extraFee: (1000).microAlgo() }),
      ).rejects.toThrow(transformedError(errUnauthorized))

      // New admin can update
      const newClient = makePeriodClient(localnet, periodAppId, newAdmin)
      await expect(
        newClient.send.update.bare({ extraFee: (1000).microAlgo() }),
      ).resolves.toBeDefined()
    })

    test('Non-admin cannot delete a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, nonAdmin)
      await expect(
        client.send.delete.bare({ extraFee: (1000).microAlgo() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Registry admin can delete a period app', async () => {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      const periodAppId = await sdk.getPeriodAppId(periodId)
      const client = makePeriodClient(localnet, periodAppId, admin)
      await expect(
        client.send.delete.bare({ extraFee: (1000).microAlgo() }),
      ).resolves.toBeDefined()
    })
  })

  // ── withdrawALGO (admin via registry c2c) ────────────────────────

  describe('withdrawALGO', () => {
    const makePeriodClient = (
      localnet: ReturnType<typeof algorandFixture>,
      appId: bigint,
      sender: Address,
    ) =>
      new GGovPeriodClient({
        algorand: localnet.algorand,
        appId,
        defaultSender: sender,
        defaultSigner: localnet.algorand.account.getSigner(sender),
      })

    /** Deploy a committee, set operator, and spawn a single period app. Returns the period app context. */
    async function deployWithPeriod(localnet: ReturnType<typeof algorandFixture>) {
      const { sdk, committeeId, admin } = await deployWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
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

    test('Cannot withdraw to the zero address', async () => {
      const { sdk, periodId, periodAddress } = await deployWithPeriod(localnet)
      await localnet.algorand.account.ensureFundedFromEnvironment(periodAddress, (6).algos())
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      await expect(
        sdk.withdrawPeriodALGO({ periodId, receiver: ALGORAND_ZERO_ADDRESS_STRING, amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('Withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { sdk, periodId } = await deployWithPeriod(localnet)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        sdk.withdrawPeriodALGO({ periodId, receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })
  })
})
