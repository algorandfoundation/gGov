import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount } from 'algosdk'
import { GGovCommitteeFile } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import {
  errCommitteeIncomplete,
  errCommitteeNotExists,
  errNoEscrows,
  errRegistryMissing,
  errUnauthorized,
} from '../base/errors.algo'
import {
  deployFracInstance,
  deployRegistryWithCommittee,
  generateAccountWithFracSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

/** A fresh address that is not a gov on any committee. */
const nonGovEscrow = () => generateAccount().addr.toString()

/** An arbitrary well-formed committee ID that was never registered. */
const unknownCommitteeId = () => new Uint8Array(32).fill(7)

/**
 * gGov registry with one fully-ingested committee, plus a frac registry + instance bound to it.
 * The instance's operator resolves to `testAccount` (registry defaultOperator = creator).
 */
const setupSync = async (localnet: AlgorandFixture, { numGovs = 3, votesPerMember = 10 } = {}) => {
  const { testAccount } = localnet.context
  const {
    sdk: ggovSdk,
    committeeId,
    govAccounts,
  } = await deployRegistryWithCommittee(localnet, numGovs, votesPerMember)
  const { sdk: fracSdk, instanceId } = await deployFracInstance(localnet, testAccount)
  await fracSdk.registry.setGGovRegistryApp({ appId: ggovSdk.appId })
  return { testAccount, ggovSdk, committeeId, govAccounts, fracSdk, instanceId }
}

describe('FracDelegationInstance committees', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('syncCommittee', () => {
    test('syncs each escrow voting power from the gGov registry and totals them', async () => {
      const { committeeId, govAccounts, fracSdk, instanceId } = await setupSync(localnet)

      // Two of the three committee members are escrows of this instance.
      const escrows = [govAccounts[0].toString(), govAccounts[1].toString()]
      for (const account of escrows) {
        await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account })
      }

      // Nothing synced yet.
      expect(await fracSdk.getCommittee(instanceId, committeeId)).toBeUndefined()

      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })

      const committee = (await fracSdk.getCommittee(instanceId, committeeId))!
      // Committee numeric IDs start at 1, so the first committee is 1 and 0 stays free as the
      // registry's "no such committee" sentinel.
      expect(committee.committeeNumId).toBe(1)
      expect(committee.escrowsVotes).toEqual([10, 10])
      expect(committee.totalVotes).toBe(20)
    })

    test('escrowsVotes is index-synced with the escrows box', async () => {
      const { committeeId, govAccounts, fracSdk, instanceId } = await setupSync(localnet)

      // Interleave a non-member escrow so the arrays only line up if indexes are respected.
      const escrows = [govAccounts[0].toString(), nonGovEscrow(), govAccounts[1].toString()]
      for (const account of escrows) {
        await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account })
      }

      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })

      expect(await fracSdk.getEscrows(instanceId)).toEqual(escrows)
      const committee = (await fracSdk.getCommittee(instanceId, committeeId))!
      // Index 1 is the non-member: it contributes 0 rather than failing the whole sync.
      expect(committee.escrowsVotes).toEqual([10, 0, 10])
      expect(committee.totalVotes).toBe(20)
    })

    test('re-runs to pick up escrows registered after the first sync', async () => {
      const { committeeId, govAccounts, fracSdk, instanceId } = await setupSync(localnet)

      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })
      expect((await fracSdk.getCommittee(instanceId, committeeId))!.escrowsVotes).toEqual([10])
      expect((await fracSdk.getCommittee(instanceId, committeeId))!.totalVotes).toBe(10)

      // Two more escrows join, then a re-sync rebuilds the record (box grows).
      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[1].toString() })
      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[2].toString() })
      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })

      const resynced = (await fracSdk.getCommittee(instanceId, committeeId))!
      expect(resynced.escrowsVotes).toEqual([10, 10, 10])
      expect(resynced.totalVotes).toBe(30)
      expect(resynced.committeeNumId).toBe(1)
    })

    test('keeps a separate record per committee', async () => {
      const { committeeId, govAccounts, fracSdk, instanceId, ggovSdk } = await setupSync(localnet)

      // A second committee on the same gGov registry gets the next numeric ID.
      const secondCommitteeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        periodStart: 5_000_000,
        periodEnd: 6_000_000,
        totalMembers: 1,
        totalVotes: 25,
        registryId: 0,
        govs: [{ address: govAccounts[0].toString(), votes: 25 }],
      }
      const secondCommitteeId = await ggovSdk.uploadCommitteeFile(secondCommitteeFile)

      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })
      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId: secondCommitteeId })

      const first = (await fracSdk.getCommittee(instanceId, committeeId))!
      const second = (await fracSdk.getCommittee(instanceId, secondCommitteeId))!
      expect(first.committeeNumId).toBe(1)
      expect(first.totalVotes).toBe(10)
      expect(second.committeeNumId).toBe(2)
      // The same escrow can hold voting power in more than one committee.
      expect(second.totalVotes).toBe(25)
    })

    test('syncs an escrow count that outgrows one txn worth of reference slots', async () => {
      // The gGov registry reads a box per escrow to resolve its voting power, so the group needs
      // roughly one reference slot per escrow against a cap of 8 per app call. At 9 escrows it needs
      // 16, which no single app call can carry: makeSyncCommitteeTxns has to pad the group with
      // extra app calls or resource population fails with "No more transactions below reference
      // limit". 9 is the smallest count that fails unpadded.
      const numEscrows = 9
      const { committeeId, govAccounts, fracSdk, instanceId } = await setupSync(localnet, {
        numGovs: numEscrows,
      })
      for (const account of govAccounts.map((a) => a.toString())) {
        await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account })
      }

      await fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })

      const committee = (await fracSdk.getCommittee(instanceId, committeeId))!
      expect(committee.escrowsVotes).toEqual(Array.from({ length: numEscrows }, () => 10))
      expect(committee.totalVotes).toBe(numEscrows * 10)
    })
  })

  describe('syncCommittee rejections', () => {
    test('a non-operator cannot sync', async () => {
      const { committeeId, fracSdk, instanceId } = await setupSync(localnet)
      const { sdk: nonOperatorSdk } = await generateAccountWithFracSDK(localnet, fracSdk.appId, (3).algos())

      await expect(nonOperatorSdk.syncCommittee({ instanceNumId: instanceId, committeeId })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('rejects when the instance has no registered escrows', async () => {
      const { committeeId, fracSdk, instanceId } = await setupSync(localnet)

      // No registerEscrow call: there is nothing to snapshot, so the sync must not write a record.
      await expect(fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })).rejects.toThrow(
        transformedError(errNoEscrows),
      )
      expect(await fracSdk.getCommittee(instanceId, committeeId)).toBeUndefined()
    })

    test('rejects a committee the gGov registry does not know', async () => {
      const { govAccounts, fracSdk, instanceId } = await setupSync(localnet)
      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })

      await expect(
        fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId: unknownCommitteeId() }),
      ).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('rejects while the frac registry has no gGov registry configured', async () => {
      const { testAccount } = localnet.context
      const { committeeId } = await deployRegistryWithCommittee(localnet)
      // Instance spawned from a registry that was never pointed at a gGov registry.
      const { sdk: fracSdk, instanceId } = await deployFracInstance(localnet, testAccount)

      await expect(fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId })).rejects.toThrow(
        transformedError(errRegistryMissing),
      )
    })

    test('rejects a committee that is not fully ingested', async () => {
      const { testAccount } = localnet.context
      const { sdk: ggovSdk, govAccounts } = await deployRegistryWithCommittee(localnet)
      const { sdk: fracSdk, instanceId } = await deployFracInstance(localnet, testAccount)
      await fracSdk.registry.setGGovRegistryApp({ appId: ggovSdk.appId })
      await fracSdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })

      // Register a committee but ingest none of its govs, leaving ingestedVotes < totalVotes.
      const partialCommitteeId = new Uint8Array(32).fill(9)
      await ggovSdk.registerCommittee({
        committeeId: partialCommitteeId,
        periodStart: 5_000_000,
        periodEnd: 6_000_000,
        totalMembers: 2,
        totalVotes: 20,
        xGovRegistryId: 0,
      })

      await expect(
        fracSdk.syncCommittee({ instanceNumId: instanceId, committeeId: partialCommitteeId }),
      ).rejects.toThrow(transformedError(errCommitteeIncomplete))
    })
  })
})
