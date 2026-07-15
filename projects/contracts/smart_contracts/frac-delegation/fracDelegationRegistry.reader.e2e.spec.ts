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
    const { registrySdk, instanceId } = await deployFracInstance(localnet, testAccount)
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
      const { registrySdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const { sdk: strangerSdk } = await generateAccountWithFracRegSDK(localnet, registrySdk.appId, (1).algos())
      const [target] = await freshAddresses(1)

      await expect(
        strangerSdk.writeClient!.send.getOrCreateAccountWithInstance({
          args: { account: target, instanceNumId: instanceId },
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('an account registered with two instances lists both instance ids', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, instanceId: instanceId1 } = await deployFracInstance(localnet, testAccount)
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
