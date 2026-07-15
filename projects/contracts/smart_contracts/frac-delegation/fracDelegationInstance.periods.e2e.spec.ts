import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { GGovSDK } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
// errGGovHasVotes (blocking re-sync over live tallies) has no test yet: nothing can cast a vote
// into the cache until voteInternal/voteExternal land, so the branch is unreachable from here.
import { errCommitteeNotExists, errGGovNotReady, errGGovPeriodNotExists, errUnauthorized } from '../base/errors.algo'
import {
  deployFracInstance,
  deployRegistryWithCommittee,
  generateAccountWithFracInstanceSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

/**
 * Create a period on `ggovSdk`, add `topicOptionsList` as topics, pull the voting window into the
 * present and mark it ready. Mirrors `createVotingPeriod` in ggovPeriod.e2e.spec.ts: topics can only
 * be added while the period is not ready, and votingStart must be future until they are all in.
 */
const createReadyPeriod = async (ggovSdk: GGovSDK, committeeId: Uint8Array, topicOptionsList: string[][]) => {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const periodId = await ggovSdk.registry.addPeriod({
    committeeId,
    votingStart: now + 10_000n,
    votingEnd: now + 20_000n,
  })
  for (const options of topicOptionsList) {
    await ggovSdk.addTopic({ periodId, options })
  }
  await ggovSdk.editPeriod({ periodId, committeeId, votingStart: now - 600n, votingEnd: now + 3600n })
  await ggovSdk.setReady({ periodId, ready: true })
  return periodId
}

/**
 * gGov registry with one fully-ingested committee, plus a frac registry + instance bound to it.
 * The instance's operator resolves to `testAccount` (registry defaultOperator = creator), which is
 * also set as the gGov operator so it can drive period creation.
 */
const setupSync = async (localnet: AlgorandFixture, { numGovs = 3, votesPerMember = 10 } = {}) => {
  const { testAccount } = localnet.context
  const {
    sdk: ggovRegistrySdk,
    committeeId,
    govAccounts,
  } = await deployRegistryWithCommittee(localnet, numGovs, votesPerMember)
  // deployRegistryWithCommittee hands back the registry-only SDK; period ops (addTopic/setReady/
  // getPeriodShort) live on the combined GGovSDK, with registry ops behind `.registry`.
  const ggovSdk = new GGovSDK({
    algorand: localnet.algorand,
    registryAppId: ggovRegistrySdk.appId,
    writerAccount: { sender: testAccount, signer: localnet.algorand.account.getSigner(testAccount) },
  })
  await ggovSdk.registry.setOperator({ account: testAccount.toString() })
  const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
  await registrySdk.setGGovRegistryApp({ appId: ggovRegistrySdk.appId })
  return { testAccount, ggovSdk, ggovRegistrySdk, committeeId, govAccounts, registrySdk, instanceSdk, instanceId }
}

/** The full setup most tests want: escrows registered and the committee already synced. */
const setupWithSyncedCommittee = async (localnet: AlgorandFixture, numEscrows = 2) => {
  const ctx = await setupSync(localnet, { numGovs: Math.max(3, numEscrows) })
  const escrows = ctx.govAccounts.slice(0, numEscrows).map((a) => a.toString())
  for (const account of escrows) {
    await ctx.registrySdk.registerEscrow({ instanceNumId: ctx.instanceId, account })
  }
  await ctx.instanceSdk.syncCommittee({ committeeId: ctx.committeeId })
  return { ...ctx, escrows }
}

/** Two topics of differing width, so an option-count mixup can't pass unnoticed. */
const TOPICS = [
  ['Yes', 'No'],
  ['A', 'B', 'C', 'D'],
]

describe('FracDelegationInstance periods', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('syncPeriod', () => {
    test('records the period identity and topic shape from the period app', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      const periodAppId = await ggovSdk.getPeriodAppId(periodId)

      // Nothing synced yet.
      expect(await instanceSdk.getPeriod(periodId)).toBeUndefined()

      await instanceSdk.syncPeriod({ periodApp: periodAppId })

      const period = (await instanceSdk.getPeriod(periodId))!
      expect(period.periodAppId).toBe(periodAppId)
      expect(period.committeeId).toEqual(committeeId)
      // Copied from the local committee box, not re-read from the gGov registry.
      expect(period.committeeNumId).toBe(1)
      expect(period.numEscrows).toBe(2)
      // One entry per topic, holding that topic's option count.
      expect(period.topicOptionLengths).toEqual([2, 4])

      // The window agrees with what the period app itself reports.
      const short = await ggovSdk.getPeriodShort(periodId)
      expect(period.votingStart).toBe(short.votingStart)
      expect(period.votingEnd).toBe(short.votingEnd)
    })

    test('zero-fills the aggregate tallies to the topic shape', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })

      const cache = (await instanceSdk.getPeriodVoteCache(periodId))!
      expect(cache.internal).toEqual([
        [0, 0],
        [0, 0, 0, 0],
      ])
      expect(cache.ggovTotals).toEqual([
        [0, 0],
        [0, 0, 0, 0],
      ])
    })

    test('stands up one zero-filled escrow box per escrow of the committee snapshot', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet, 3)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })

      for (const i of [0, 1, 2]) {
        expect((await instanceSdk.getPeriodEscrowVotes(periodId, i))!.votes).toEqual([
          [0, 0],
          [0, 0, 0, 0],
        ])
      }
      // Exactly numEscrows boxes: index 3 was never stood up.
      expect(await instanceSdk.getPeriodEscrowVotes(periodId, 3)).toBeUndefined()
    })

    test('keeps a separate record per period', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const firstId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      const secondId = await createReadyPeriod(ggovSdk, committeeId, [['Only']])

      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(firstId) })
      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(secondId) })

      expect((await instanceSdk.getPeriod(firstId))!.topicOptionLengths).toEqual([2, 4])
      expect((await instanceSdk.getPeriod(secondId))!.topicOptionLengths).toEqual([1])
      expect((await instanceSdk.getPeriodVoteCache(secondId))!.internal).toEqual([[0]])
    })

    test('re-syncs a pristine period, widening escrows picked up by a committee re-sync', async () => {
      const { ggovSdk, committeeId, govAccounts, registrySdk, instanceSdk, instanceId } =
        await setupWithSyncedCommittee(localnet, 1)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      const periodApp = await ggovSdk.getPeriodAppId(periodId)

      await instanceSdk.syncPeriod({ periodApp })
      expect((await instanceSdk.getPeriod(periodId))!.numEscrows).toBe(1)
      expect(await instanceSdk.getPeriodEscrowVotes(periodId, 1)).toBeUndefined()

      // A new escrow joins. The period only sees it once the committee snapshot behind it is
      // refreshed and the period re-synced on top.
      await registrySdk.registerEscrow({ instanceNumId: instanceId, account: govAccounts[1].toString() })
      await instanceSdk.syncCommittee({ committeeId })
      await instanceSdk.syncPeriod({ periodApp })

      expect((await instanceSdk.getPeriod(periodId))!.numEscrows).toBe(2)
      expect((await instanceSdk.getPeriodEscrowVotes(periodId, 1))!.votes).toEqual([
        [0, 0],
        [0, 0, 0, 0],
      ])
    })

    test('syncs an escrow count that outgrows one txn worth of reference slots', async () => {
      // One box per escrow means one reference slot per escrow, against a cap of 8 per app call.
      // syncPeriod needs N+6 (N escrow boxes + periods + periodVoteCache + committees + the period's
      // topicOptionsArr box + the periodApp and registryApp refs), so at 11 escrows it needs 17 and
      // makeSyncPeriodTxns has to pad the group past the two app calls it would otherwise get.
      // 11 is the smallest count that fails unpadded — below that an increaseBudget call prepended
      // for the opcode budget happens to donate the slots.
      const numEscrows = 11
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet, numEscrows)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)

      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })

      expect((await instanceSdk.getPeriod(periodId))!.numEscrows).toBe(numEscrows)
      const state = (await instanceSdk.getPeriodVotingState(periodId))!
      expect(state.escrowVotes).toEqual(
        Array.from({ length: numEscrows }, () => [
          [0, 0],
          [0, 0, 0, 0],
        ]),
      )
    })
  })

  describe('logPeriodVotingState', () => {
    test('dumps the period, both tallies and every escrow in one simulate', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet, 3)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      const periodAppId = await ggovSdk.getPeriodAppId(periodId)
      await instanceSdk.syncPeriod({ periodApp: periodAppId })

      const state = (await instanceSdk.getPeriodVotingState(periodId))!

      expect(state.period.periodAppId).toBe(periodAppId)
      expect(state.period.committeeId).toEqual(committeeId)
      expect(state.period.topicOptionLengths).toEqual([2, 4])
      expect(state.internal).toEqual([
        [0, 0],
        [0, 0, 0, 0],
      ])
      expect(state.ggovTotals).toEqual([
        [0, 0],
        [0, 0, 0, 0],
      ])
      // One entry per escrow, index-aligned with getEscrows().
      expect(state.escrowVotes).toHaveLength(3)
      expect(state.escrowVotes).toEqual(
        Array.from({ length: 3 }, () => [
          [0, 0],
          [0, 0, 0, 0],
        ]),
      )
    })

    test('agrees with the individual box reads', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      await instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })

      const state = (await instanceSdk.getPeriodVotingState(periodId))!
      expect(state.period).toEqual(await instanceSdk.getPeriod(periodId))
      const cache = (await instanceSdk.getPeriodVoteCache(periodId))!
      expect(state.internal).toEqual(cache.internal)
      expect(state.ggovTotals).toEqual(cache.ggovTotals)
      expect(state.escrowVotes[1]).toEqual((await instanceSdk.getPeriodEscrowVotes(periodId, 1))!.votes)
    })

    test('returns undefined for a period that was never synced', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)

      // Logs nothing at all, which the reader surfaces as absence rather than an empty record.
      expect(await instanceSdk.getPeriodVotingState(periodId)).toBeUndefined()
    })
  })

  describe('syncPeriod rejections', () => {
    test('a non-operator cannot sync', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)
      const periodApp = await ggovSdk.getPeriodAppId(periodId)
      const { sdk: nonOperatorSdk } = await generateAccountWithFracInstanceSDK(localnet, instanceSdk.appId, (3).algos())

      await expect(nonOperatorSdk.syncPeriod({ periodApp })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects a period whose committee has not been synced locally', async () => {
      // Escrows registered, but syncCommittee never run: there is no committeeNumId or per-escrow
      // voting power to build the period record from.
      const { ggovSdk, committeeId, registrySdk, instanceSdk, instanceId, govAccounts } = await setupSync(localnet)
      await registrySdk.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
      const periodId = await createReadyPeriod(ggovSdk, committeeId, TOPICS)

      await expect(instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })).rejects.toThrow(
        transformedError(errCommitteeNotExists),
      )
      expect(await instanceSdk.getPeriod(periodId)).toBeUndefined()
    })

    test('rejects a period that is not marked ready', async () => {
      const { ggovSdk, committeeId, instanceSdk } = await setupWithSyncedCommittee(localnet)
      // Topics stay editable while not ready, so the shape could still drift out from under us.
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await ggovSdk.registry.addPeriod({
        committeeId,
        votingStart: now + 1000n,
        votingEnd: now + 5000n,
      })
      await ggovSdk.addTopic({ periodId, options: ['Yes', 'No'] })

      await expect(instanceSdk.syncPeriod({ periodApp: await ggovSdk.getPeriodAppId(periodId) })).rejects.toThrow(
        transformedError(errGGovNotReady),
      )
    })

    test('rejects an app that is not a gGov period', async () => {
      const { ggovRegistrySdk, instanceSdk } = await setupWithSyncedCommittee(localnet)

      // The gGov registry is a real app, but has no `periodId` global state.
      await expect(instanceSdk.syncPeriod({ periodApp: ggovRegistrySdk.appId })).rejects.toThrow(
        transformedError(errGGovPeriodNotExists),
      )
    })
  })
})
