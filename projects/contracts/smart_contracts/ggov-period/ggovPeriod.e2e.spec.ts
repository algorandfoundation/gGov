import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovSDK } from 'ggov-sdk'
import { GGovRegistryFactory, XGovCommitteeFile } from 'ggov-registry-sdk'
import {
  errGGovCannotOverride,
  errGGovHasVotes,
  errGGovNoDelegation,
  errGGovNoOptions,
  errGGovNotReady,
  errGGovReady,
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

async function deployRegistryAndSDK(localnet: ReturnType<typeof algorandFixture>, admin: Address) {
  const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: admin,
  })
  const { appClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })
  await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (10).algos())
  const sdk = new GGovSDK({
    algorand: localnet.algorand,
    ggovRegistryAppId: appClient.appId,
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
    ggovRegistryAppId: appId,
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
      await voterSDK.delegate({ delegatee: delegatee.toString() })

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

    test('Cannot self-delegate', async () => {
      const { appClient, admin } = await deployWithCommittee(localnet)
      const adminSDK = createUserSDK(localnet, appClient.appId, admin)
      await expect(adminSDK.delegate({ delegatee: admin.toString() })).rejects.toThrow(
        transformedError(errGGovSelfDelegate),
      )
    })

    test('Can undelegate', async () => {
      const { sdk, appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })
      await voterSDK.undelegate({})
      const delegation = await sdk.getDelegation(voter.toString())
      expect(delegation.exists).toBe(false)
    })

    test('Undelegate fails without existing delegation', async () => {
      const { appClient, xGovAccounts } = await deployWithCommittee(localnet)
      const voter = xGovAccounts[0]
      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await expect(voterSDK.undelegate({})).rejects.toThrow(transformedError(errGGovNoDelegation))
    })

    test('Delegatee cannot override direct vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })

      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await expect(
        delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))
    })

    test('Voter can override delegatee vote', async () => {
      const { sdk, appClient, committeeId, xGovAccounts, admin } = await deployWithCommittee(localnet, 1, 10)
      await sdk.setOperator({ account: admin.toString() })
      const periodId = await createVotingPeriod(sdk, committeeId, [['Yes', 'No']])
      const voter = xGovAccounts[0]
      const delegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const voterSDK = createUserSDK(localnet, appClient.appId, voter)
      await voterSDK.delegate({ delegatee: delegatee.toString() })
      const delegateeSDK = createUserSDK(localnet, appClient.appId, delegatee)
      await delegateeSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[10, 0]] })
      await voterSDK.vote({ periodId, voterAccount: voter.toString(), topicVotes: [[0, 10]] })

      const period = await sdk.getPeriod(periodId)
      expect(period.topics[0][1]).toEqual([0, 10])

      const record = await sdk.getVotingRecord(periodId, voter.toString())
      expect(record!.byDelegator).toBe(false)
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
})
