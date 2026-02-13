import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  XGovCommitteeFile,
  XGovCommitteesOracleSDK,
} from 'xgov-committees-oracle-sdk'
import { GGovSDK, GGovFactory } from 'ggov-sdk'
import {
  errGGovCannotOverride,
  errGGovHasVotes,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovPeriodNotExists,
  errGGovSelfDelegate,
  errGGovTopicIndexOOB,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingNotStarted,
  errNotOperator,
  errPeriodEndLessThanStart,
  errUnauthorized,
} from '../base/errors.algo'
import { transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'

// Helper to deploy GGov contract and create SDK
async function deployGGov(localnet: ReturnType<typeof algorandFixture>, admin: Address) {
  const factory = localnet.algorand.client.getTypedAppFactory(GGovFactory, {
    defaultSender: admin,
  })

  const { appClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

  await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (10).algos())

  const sdk = new GGovSDK({
    algorand: localnet.algorand,
    ggovAppId: appClient.appId,
    writerAccount: {
      sender: admin,
      signer: localnet.algorand.account.getSigner(admin),
    },
    debug: false,
  })

  return { appClient, sdk }
}

// Helper: create SDK for a specific user account
function createUserSDK(localnet: ReturnType<typeof algorandFixture>, appId: bigint, user: Address) {
  return new GGovSDK({
    algorand: localnet.algorand,
    ggovAppId: appId,
    writerAccount: {
      sender: user,
      signer: localnet.algorand.account.getSigner(user),
    },
    debug: false,
  })
}

// Helper: deploy gGov + set up a committee with xGov members
async function deployGGovWithCommittee(
  localnet: ReturnType<typeof algorandFixture>,
  numXGovs = 3,
  votesPerMember = 10,
) {
  const { testAccount: admin } = localnet.context
  const { appClient, sdk } = await deployGGov(localnet, admin)

  // Create xGov accounts
  const xGovAccounts = await Promise.all(
    Array.from({ length: numXGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )

  // Build committee file
  const committeeFile: XGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: numXGovs,
    totalVotes: numXGovs * votesPerMember,
    registryId: 0,
    xGovs: xGovAccounts.map((a) => ({
      address: a.toString(),
      votes: votesPerMember,
    })),
  }

  // Use the SDK's uploadCommitteeFile (gGov IS the oracle)
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)

  return { appClient, sdk, committeeId, committeeFile, xGovAccounts, admin }
}

/**
 * Helper: create a period with topics, ready for voting.
 * Creates period with future votingStart, adds topics, then edits period to move votingStart to past.
 */
async function createVotingPeriod(
  sdk: GGovSDK,
  committeeId: Uint8Array,
  topicOptionsList: string[][],
) {
  const now = BigInt(Math.floor(Date.now() / 1000))

  // Create period with future voting start
  const periodId = await sdk.addPeriod({
    committeeId,
    votingStart: now + 10000n,
    votingEnd: now + 20000n,
  })

  // Add topics while voting hasn't started
  for (const options of topicOptionsList) {
    await sdk.addTopic({ periodId, options })
  }

  // Edit period to move voting start to the past
  await sdk.editPeriod({
    periodId,
    votingStart: now - 100n,
    votingEnd: now + 3600n,
  })

  return periodId
}

describe('GGov contract', () => {
  const localnet = algorandFixture()

  beforeAll(() => {
    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  // ── Admin: setOperator ──────────────────────────────────────────

  describe('setOperator', () => {
    test('Admin can set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { sdk } = await deployGGov(localnet, admin)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await sdk.setOperator({ account: operator.toString() })

      const state = await sdk.ggovWriteClient!.state.global.getAll()
      expect(state.operator).toBeDefined()
    })

    test('Non-admin cannot set operator', async () => {
      const { testAccount: admin } = localnet.context
      const { appClient } = await deployGGov(localnet, admin)
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const nonAdminSDK = createUserSDK(localnet, appClient.appId, nonAdmin)
      await expect(
        nonAdminSDK.setOperator({ account: nonAdmin.toString() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })

  // ── Operator: addPeriod ─────────────────────────────────────────

  describe('addPeriod', () => {
    test('Operator can add a period', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 100n,
        votingEnd: now + 3700n,
      })
      expect(periodId).toBe(1n)

      // Verify period data
      const period = await sdk.getPeriod(1n)
      expect(period.votingStart).toBeGreaterThan(0)
      expect(period.topics).toHaveLength(0)
    })

    test('Non-operator cannot add a period', async () => {
      const { appClient, sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      // admin is NOT the operator, but admin SDK is the default
      await expect(
        sdk.addPeriod({
          committeeId,
          votingStart: now + 100n,
          votingEnd: now + 3700n,
        }),
      ).rejects.toThrow(transformedError(errNotOperator))
    })

    test('Rejects votingEnd <= votingStart', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({
          committeeId,
          votingStart: now + 3700n,
          votingEnd: now + 100n,
        }),
      ).rejects.toThrow(transformedError(errPeriodEndLessThanStart))
    })
  })

  // ── Operator: editPeriod ────────────────────────────────────────

  describe('editPeriod', () => {
    test('Operator can edit a future period', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      await sdk.editPeriod({
        periodId,
        votingStart: now + 2000n,
        votingEnd: now + 6000n,
      })

      const period = await sdk.getPeriod(periodId)
      expect(BigInt(period.votingStart)).toBe(now + 2000n)
    })

    test('Cannot edit nonexistent period', async () => {
      const { sdk, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.editPeriod({ periodId: 999n, votingStart: now + 100n, votingEnd: now + 200n }),
      ).rejects.toThrow(transformedError(errGGovPeriodNotExists))
    })
  })

  // ── Operator: addTopic ──────────────────────────────────────────

  describe('addTopic', () => {
    test('Operator can add topics to a period', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const topicIdx0 = await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
      expect(topicIdx0).toBe(0n)

      const topicIdx1 = await sdk.addTopic({ periodId, options: ['Option A', 'Option B'] })
      expect(topicIdx1).toBe(1n)

      // Verify topics are stored (topics are [string[], number[]] tuples)
      const period = await sdk.getPeriod(periodId)
      expect(period.topics).toHaveLength(2)
      expect(period.topics[0][0]).toEqual(['Yes', 'No', 'Abstain']) // options
      expect(period.topics[0][1]).toEqual([0, 0, 0]) // votes
      expect(period.topics[1][0]).toEqual(['Option A', 'Option B']) // options
    })

    test('Rejects empty options', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      await expect(
        sdk.addTopic({ periodId, options: [] }),
      ).rejects.toThrow(transformedError(errGGovNoOptions))
    })
  })

  // ── Operator: editTopic ─────────────────────────────────────────

  describe('editTopic', () => {
    test('Operator can edit a topic with no votes', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
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
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      await expect(
        sdk.editTopic({ periodId, topicIndex: 0n, options: ['Yes'] }),
      ).rejects.toThrow(transformedError(errGGovTopicIndexOOB))
    })
  })

  // ── Voting ──────────────────────────────────────────────────────

  describe('vote', () => {
    test('xGov can vote on all topics', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 3, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No'],
        ['A', 'B', 'C'],
      ])

      // xGov[0] votes via their own SDK
      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [
          [7, 3],       // Topic 0: 7 Yes, 3 No
          [4, 4, 2],    // Topic 1: 4 A, 4 B, 2 C
        ],
      })

      // Verify vote tallies on period
      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([7, 3])
      expect(period.topics[1][1]).toEqual([4, 4, 2])

      // Verify vote record
      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record.byDelegator).toBe(false)
      expect(record.topicVotes[0]).toEqual([7, 3])
      expect(record.topicVotes[1]).toEqual([4, 4, 2])
    })

    test('Multiple xGovs voting accumulates tallies', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 3, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      // Two voters each with 10 voting power
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
      expect(period.topics[0][1]).toEqual([13, 7]) // 10+3, 0+7
    })

    test('Vote update subtracts old and adds new', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)

      // First vote
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[8, 2]] })

      // Re-vote
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[3, 7]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([3, 7])
    })

    test('Rejects vote before voting starts', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 9999n,
        votingEnd: now + 19999n,
      })
      await sdk.addTopic({ periodId, options: ['Yes', 'No'] })

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVotingNotStarted))
    })

    test('Rejects vote with wrong topic count', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [
        ['Yes', 'No'],
        ['A', 'B'],
      ])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      // Only provide votes for 1 topic instead of 2
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] }),
      ).rejects.toThrow(transformedError(errGGovVoteMismatch))
    })

    test('Rejects vote with wrong power sum', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      // Sum is 5+6=11, but voting power is 10
      await expect(
        voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[5, 6]] }),
      ).rejects.toThrow(transformedError(errGGovVotePowerMismatch))
    })
  })

  // ── Delegation ──────────────────────────────────────────────────

  describe('delegation', () => {
    test('Account can delegate and delegatee can vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // Delegate via voter's SDK
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })

      // Verify delegation
      const delegation = await sdk.getDelegation(voter.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(delegatee.toString())

      // Delegatee votes on behalf of voter
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({
        periodId,
        voterAccount: voter.toString(),
        topicVotes: [[10, 0]],
      })

      // Verify vote was recorded
      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record.byDelegator).toBe(true)
      expect(record.topicVotes[0]).toEqual([10, 0])
    })

    test('Cannot self-delegate', async () => {
      const { appClient, admin } = await deployGGovWithCommittee(localnet)
      const adminSDK = createUserSDK(localnet, appClient.appId, admin)

      await expect(
        adminSDK.delegate({ delegatee: admin.toString() }),
      ).rejects.toThrow(transformedError(errGGovSelfDelegate))
    })

    test('Can undelegate', async () => {
      const { sdk, appClient, xGovAccounts } = await deployGGovWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })
      await voterSDK.undelegate({})

      const delegation = await sdk.getDelegation(voter.toString())
      expect(delegation.exists).toBe(false)
    })

    test('Undelegate fails without existing delegation', async () => {
      const { appClient, xGovAccounts } = await deployGGovWithCommittee(localnet)
      const voter = xGovAccounts[0]

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(
        voterSDK.undelegate({}),
      ).rejects.toThrow(transformedError(errGGovNoDelegation))
    })

    test('Delegatee cannot override direct vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // Delegate
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })

      // Voter votes directly
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      // Delegatee tries to override — should fail
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await expect(
        delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))
    })

    test('Voter can override delegatee vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // Delegate
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })

      // Delegatee votes
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      // Voter overrides directly — should succeed
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record.byDelegator).toBe(false)
    })
  })

  // ── Read methods ────────────────────────────────────────────────

  describe('read methods', () => {
    test('getPeriod returns empty for nonexistent period', async () => {
      const { sdk } = await deployGGovWithCommittee(localnet)

      const period = await sdk.getPeriod(999n)
      expect(period.votingStart).toBe(0)
      expect(period.votingEnd).toBe(0)
      expect(period.topics).toHaveLength(0)
    })

    test('getVotingRecord returns empty for nonexistent record', async () => {
      const { sdk, xGovAccounts } = await deployGGovWithCommittee(localnet)

      const record = await sdk.getVotingRecord(1n, xGovAccounts[0].toString())
      expect(record.byDelegator).toBe(false)
      expect(record.topicVotes).toHaveLength(0)
    })

    test('getDelegation returns false for no delegation', async () => {
      const { sdk, xGovAccounts } = await deployGGovWithCommittee(localnet)

      const delegation = await sdk.getDelegation(xGovAccounts[0].toString())
      expect(delegation.exists).toBe(false)
    })

    test('canVote returns true for eligible voter in active period', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      const result = await sdk.canVote(periodId, xGovAccounts[0].toString(), xGovAccounts[0].toString())
      expect(result.canVote).toBe(true)
      expect(result.votingPower).toBe(10n)
    })

    test('canVote returns false for nonexistent period', async () => {
      const { sdk, xGovAccounts } = await deployGGovWithCommittee(localnet, 1, 10)

      const result = await sdk.canVote(999n, xGovAccounts[0].toString(), xGovAccounts[0].toString())
      expect(result.canVote).toBe(false)
    })
  })

  // ── Chunked uploads ─────────────────────────────────────────────

  describe('uploadPeriodBodyPartial', () => {
    test('Operator can upload period body in one chunk', async () => {
      const { sdk, committeeId, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })

      const bodyJson = new TextEncoder().encode('{"title":"Test Period","description":"A test."}')
      await sdk.uploadPeriodBodyPartial({
        periodId,
        startOffset: 0n,
        data: bodyJson,
        last: true,
      })
    })

    test('Rejects upload for nonexistent period', async () => {
      const { sdk, admin } = await deployGGovWithCommittee(localnet)
      await sdk.setOperator({ account: admin.toString() })

      const bodyJson = new TextEncoder().encode('{}')
      await expect(
        sdk.uploadPeriodBodyPartial({
          periodId: 999n,
          startOffset: 0n,
          data: bodyJson,
          last: true,
        }),
      ).rejects.toThrow(transformedError(errGGovPeriodNotExists))
    })
  })

  // ── editTopic with votes ────────────────────────────────────────

  describe('editTopic with existing votes', () => {
    test('Cannot edit topic after votes have been cast', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployGGovWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })

      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])

      // Cast a vote
      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      // Try to edit — should fail since votes are non-zero
      await expect(
        sdk.editTopic({ periodId, topicIndex: 0n, options: ['Approve', 'Reject'] }),
      ).rejects.toThrow(transformedError(errGGovHasVotes))
    })
  })
})
