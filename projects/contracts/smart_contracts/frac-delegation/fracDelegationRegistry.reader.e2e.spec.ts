import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import {
  deployFracInstance,
  deployFracRegistry,
  generateAccountWithFracRegSDK,
  transformedError,
} from '../common-tests'
import { errUnauthorized } from '../base/errors.algo'
import { configureTestLogging } from '../test-utils'

/**
 * Reader-side coverage for the frac registry account getters
 * (getAccounts / getAccountIdMap / getFracRegAccountsMap) and the `getAccount` contract readonly.
 *
 * Accounts are registered via `getOrCreateAccountWithInstance`, which is callable by the associated
 * instance app or the registry admin. The instance-app path has no entrypoint yet, so these tests
 * register through the admin path (the registry writer/admin is `testAccount`).
 */
describe('FracDelegationRegistry readers', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  /** Generate `count` fresh (unfunded) addresses; they only need to exist as arguments. */
  const freshAddresses = async (count: number): Promise<string[]> => {
    const { generateAccount } = await import('algosdk')
    return Array.from({ length: count }, () => generateAccount().addr.toString())
  }

  /** Register accounts against an instance via the admin path; returns the assigned account ids. */
  const registerAccounts = async (
    registrySdk: FracDelegationRegistrySDK,
    instanceNumId: bigint,
    accounts: string[],
  ): Promise<number[]> => {
    const ids: number[] = []
    for (const account of accounts) {
      const { return: record } = await registrySdk.writeClient!.send.getOrCreateAccountWithInstance({
        args: { account, instanceNumId },
      })
      ids.push(record!.accountId)
    }
    return ids
  }

  /** Deploy a registry + one instance and register `count` accounts through the admin. */
  const deployWithAccounts = async (
    localnet: AlgorandFixture,
    count: number,
  ): Promise<{ registrySdk: FracDelegationRegistrySDK; instanceId: bigint; accounts: string[]; ids: number[] }> => {
    const { testAccount } = localnet.context
    const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
    const registrySdk = sdk.registry
    const accounts = await freshAddresses(count)
    const ids = await registerAccounts(registrySdk, instanceId, accounts)
    return { registrySdk, instanceId, accounts, ids }
  }

  describe('getAccount (contract readonly)', () => {
    test('returns zero accountId and no instances for an unknown account', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const [unknown] = await freshAddresses(1)

      const { return: account } = await sdk.readClient.send.getAccount({ args: { account: unknown } })

      expect(account).toBeDefined()
      expect(account!.accountId).toBe(0)
      expect(account!.instanceNumIds).toHaveLength(0)
    })

    test('returns the populated record for a registered account', async () => {
      const { registrySdk, instanceId, accounts, ids } = await deployWithAccounts(localnet, 1)

      const { return: account } = await registrySdk.readClient.send.getAccount({ args: { account: accounts[0] } })

      expect(account!.accountId).toBe(ids[0])
      expect(account!.accountId).toBeGreaterThan(0)
      expect(account!.instanceNumIds).toEqual([Number(instanceId)])
    })
  })

  describe('SDK reader wrappers', () => {
    test('getAccounts returns an empty list for a registry with no accounts', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)

      // The registry owns non-account boxes (e.g. the 'Iap' instance-approval box); the getter must
      // filter to only 'a'-prefixed 33-byte account boxes and therefore return nothing here.
      expect(await sdk.getAccounts()).toEqual([])
    })

    test('getAccounts lists every registered account', async () => {
      const { registrySdk, accounts } = await deployWithAccounts(localnet, 3)

      const listed = await registrySdk.getAccounts()

      expect(listed.slice().sort()).toEqual(accounts.slice().sort())
    })

    test('getFracRegAccountsMap returns populated records for known accounts and empty for unknown', async () => {
      const { registrySdk, instanceId, accounts, ids } = await deployWithAccounts(localnet, 3)
      const [unknown] = await freshAddresses(1)

      const map = await registrySdk.getFracRegAccountsMap([...accounts, unknown])

      expect(map.size).toBe(4)
      accounts.forEach((account, i) => {
        const entry = map.get(account)!
        expect(entry.accountId).toBe(ids[i])
        expect(entry.accountId).toBeGreaterThan(0)
        expect(entry.instanceNumIds).toEqual([Number(instanceId)])
      })
      expect(map.get(unknown)!.accountId).toBe(0)
      expect(map.get(unknown)!.instanceNumIds).toHaveLength(0)
    })

    test('getAccountIdMap returns distinct incrementing ids for known accounts and 0 for unknown', async () => {
      const { registrySdk, accounts, ids } = await deployWithAccounts(localnet, 3)
      const [unknown] = await freshAddresses(1)

      const map = await registrySdk.getAccountIdMap([...accounts, unknown])

      accounts.forEach((account, i) => expect(map.get(account)).toBe(ids[i]))
      expect(new Set(ids).size).toBe(accounts.length) // ids are distinct
      expect(map.get(unknown)).toBe(0)
    })

    test('rejects registration by a caller that is neither the instance app nor the admin', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const { sdk: strangerSdk } = await generateAccountWithFracRegSDK(localnet, sdk.appId, (1).algos())
      const [target] = await freshAddresses(1)

      await expect(
        strangerSdk.writeClient!.send.getOrCreateAccountWithInstance({
          args: { account: target, instanceNumId: instanceId },
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('an account registered with two instances lists both instance ids', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId: instanceId1 } = await deployFracInstance(localnet, testAccount)
      const registrySdk = sdk.registry
      const { instanceId: instanceId2 } = await deployFracInstance(localnet, testAccount, { registrySdk })
      const [account] = await freshAddresses(1)

      await registerAccounts(registrySdk, instanceId1, [account])
      await registerAccounts(registrySdk, instanceId2, [account])

      const entry = (await registrySdk.getFracRegAccountsMap([account])).get(account)!
      expect(entry.instanceNumIds.slice().sort((a, b) => a - b)).toEqual(
        [Number(instanceId1), Number(instanceId2)].sort((a, b) => a - b),
      )
    })
  })

  describe('per-account cross-instance readers', () => {
    /**
     * Deploy `count` instances on one registry (distinct names) and register a single fresh account
     * against every one of them via the admin path — no AQ ingested and no committee synced, so the
     * per-instance getters resolve to their zero/empty sentinels. Returns the shared account and the
     * instance ids in creation order (which is also the account's `instanceNumIds` order).
     */
    const deployInstancesForAccount = async (localnet: AlgorandFixture, count: number) => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount, { name: 'instance-1' })
      const registrySdk = sdk.registry
      const instanceIds = [instanceId]
      for (let i = 2; i <= count; i++) {
        const { instanceId: next } = await deployFracInstance(localnet, testAccount, {
          registrySdk,
          name: `instance-${i}`,
        })
        instanceIds.push(next)
      }
      const [account] = await freshAddresses(1)
      for (const id of instanceIds) await registerAccounts(registrySdk, id, [account])
      return { registrySdk, sdk, account, instanceIds }
    }

    test('getAccountInstanceAQs returns one entry per instance, zeroed for an unsynced committee', async () => {
      const { registrySdk, sdk, account, instanceIds } = await deployInstancesForAccount(localnet, 2)
      const committeeId = new Uint8Array(32).fill(3)

      const results = await registrySdk.getAccountInstanceAQs(account, [committeeId])

      expect(results).toHaveLength(instanceIds.length)
      for (const [i, instanceId] of instanceIds.entries()) {
        expect(results[i]).toEqual({
          instanceNumId: Number(instanceId),
          instanceAppId: await sdk.getInstanceAppId(instanceId),
          committeeNumId: 0, // committee never synced on these instances
          committeeId, // echoes the input
          instanceName: (await registrySdk.getInstance(instanceId))!.name,
          userAq: 0,
          totalAq: 0,
          totalVotes: 0, // no snapshot, so no pool power either
        })
      }
    })

    test('getAccountInstanceAQs logs a row per (instance, committee) pair, instance-major', async () => {
      const { registrySdk, account, instanceIds } = await deployInstancesForAccount(localnet, 2)
      const committeeIds = [new Uint8Array(32).fill(3), new Uint8Array(32).fill(4)]

      const results = await registrySdk.getAccountInstanceAQs(account, committeeIds)

      // Both axes in one read: 2 instances x 2 committees. Instance-major - each instance's
      // committees are adjacent, in the order they were asked for.
      expect(results).toHaveLength(4)
      expect(results.map((r) => [r.instanceNumId, r.committeeId[0]])).toEqual([
        [Number(instanceIds[0]), 3],
        [Number(instanceIds[0]), 4],
        [Number(instanceIds[1]), 3],
        [Number(instanceIds[1]), 4],
      ])
    })

    test('getAccountInstanceAQs is empty for an unregistered account, and for no committees', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)
      const [unknown] = await freshAddresses(1)

      expect(await sdk.registry.getAccountInstanceAQs(unknown, [new Uint8Array(32)])).toEqual([])
      // No committees is no read at all - the committee axis is half the query, not a filter.
      expect(await sdk.registry.getAccountInstanceAQs(unknown, [])).toEqual([])
    })

    test('getAccountInstanceAQs pages instances and chunks committees, order preserved on both axes', async () => {
      // Force BOTH axes with a handful of instances: production fits ~25 instances x 1 committee per
      // simulate page, so dial the instance page to 3 (8 instances -> 3 pages) and the committee
      // chunk to 2 (3 committees -> 2 chunks). The aggregate must stay in instanceNumIds order
      // within each chunk, and every row must still name its own committee.
      const { registrySdk, account, instanceIds } = await deployInstancesForAccount(localnet, 8)
      registrySdk.aqPageSize = 3
      registrySdk.aqMaxCommitteesPerCall = 2
      const committeeIds = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)]

      // `numInstances` is what makes the instance axis bind; without it the committee axis is sized
      // first and 3 committees would fit one page of instances.
      const results = await registrySdk.getAccountInstanceAQs(account, committeeIds, { numInstances: 8 })

      expect(results).toHaveLength(instanceIds.length * committeeIds.length)
      // Committee chunks come back in chunk order ([1,2] then [3]); within a chunk, instance-major.
      const expectedOrder = [
        ...instanceIds.flatMap((id) => [
          [Number(id), 1],
          [Number(id), 2],
        ]),
        ...instanceIds.map((id) => [Number(id), 3]),
      ]
      expect(results.map((r) => [r.instanceNumId, r.committeeId[0]])).toEqual(expectedOrder)
    }, 180_000)

    test('getAccountInstanceAQs skips an instance whose app has been deleted instead of failing the page', async () => {
      const { registrySdk, sdk, account, instanceIds } = await deployInstancesForAccount(localnet, 3)
      const doomed = instanceIds[1]!
      const doomedAppId = await sdk.getInstanceAppId(doomed)

      await sdk.deleteInstanceApp({ instanceNumId: doomed })
      await expect(localnet.algorand.app.getById(doomedAppId)).rejects.toThrow()

      const results = await registrySdk.getAccountInstanceAQs(account, [new Uint8Array(32)])

      // The account's `instanceNumIds` still lists it - the record is dropped because the app it
      // would be inner-called on is gone, not because the association went away.
      expect(results.map((r) => r.instanceNumId)).toEqual([Number(instanceIds[0]), Number(instanceIds[2])])
    })

    test('getAccountVotingRecords returns empty topicVotes per instance when the account has not voted', async () => {
      const { registrySdk, sdk, account, instanceIds } = await deployInstancesForAccount(localnet, 2)

      const results = await registrySdk.getAccountVotingRecords(account, 1)

      expect(results).toHaveLength(instanceIds.length)
      for (const [i, instanceId] of instanceIds.entries()) {
        expect(results[i]).toEqual({
          instanceNumId: Number(instanceId),
          instanceAppId: await sdk.getInstanceAppId(instanceId),
          instanceName: (await registrySdk.getInstance(instanceId))!.name,
          isDelegated: false, // the empty-record default
          topicVotes: [], // no vote record for the period on any instance
        })
      }
    })

    test('getAccountVotingRecord returns one instance-tagged record decoded via the generated struct', async () => {
      // Singular getter: targets a specific (non-first) instance and returns the struct directly,
      // exercising the ARC-56-registered FracAccountVotingRecord the plural log path decodes against.
      const { registrySdk, sdk, account, instanceIds } = await deployInstancesForAccount(localnet, 2)
      const instanceId = instanceIds[1]!

      const record = await registrySdk.getAccountVotingRecord(account, instanceId, 1)

      expect(record).toEqual({
        instanceNumId: Number(instanceId),
        instanceAppId: await sdk.getInstanceAppId(instanceId),
        instanceName: (await registrySdk.getInstance(instanceId))!.name,
        isDelegated: false, // the empty-record default
        topicVotes: [], // account has not voted this period on the instance
      })
    })
  })

  describe('batch reader stress', () => {
    test('getFracRegAccountsMap: known accounts at chunk boundaries in 129 addresses stay index-aligned', async () => {
      // 129 > the 126 chunk size, so the @chunked decorator fans the request into multiple simulate
      // groups. Place known accounts at the first/middle/last positions to verify the aggregated
      // result stays aligned with the input across the chunk boundary.
      const { registrySdk, instanceId, accounts: known, ids } = await deployWithAccounts(localnet, 3)
      const addresses = await freshAddresses(129)
      addresses[0] = known[0]
      addresses[64] = known[1]
      addresses[128] = known[2]

      const map = await registrySdk.getFracRegAccountsMap(addresses)

      expect(map.size).toBe(129)
      known.forEach((account, i) => {
        const entry = map.get(account)!
        expect(entry.accountId).toBe(ids[i])
        expect(entry.instanceNumIds).toEqual([Number(instanceId)])
      })
      // spot-check unknowns on either side of the chunk boundary resolve to empty records
      expect(map.get(addresses[1])!.accountId).toBe(0)
      expect(map.get(addresses[127])!.accountId).toBe(0)
    }, 120_000)
  })
})
