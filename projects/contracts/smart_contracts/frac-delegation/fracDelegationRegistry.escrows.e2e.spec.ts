import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { generateAccount, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { errEscrowAssigned, errInstanceAppNotExists, errUnauthorized } from '../base/errors.algo'
import {
  deployFracInstance,
  generateAccountWithFracSDK,
  generateAccountWithFracRegSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'
import { MAX_ESCROWS_PER_REGISTER_GROUP } from 'frac-delegation-sdk'

/** A fresh, unfunded address — escrows are stored as data, so they never need funding. */
const newEscrow = () => generateAccount().addr.toString()

describe('FracDelegationRegistry escrows', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('registry registerEscrow', () => {
    test('admin registers an escrow: assignment recorded, counter bumped, instance list appended', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      // Before: nothing assigned, empty list, zero counter.
      expect(await sdk.getEscrowInstance(escrow)).toBeUndefined()
      expect(await sdk.getEscrows(instanceId)).toEqual([])
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(0n)

      await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: escrow })

      // Registry recorded the escrow -> instance assignment.
      expect(await sdk.getEscrowInstance(escrow)).toBe(Number(instanceId))
      // Instance counter mirrors the list length.
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(1n)
      // Instance appended the escrow to its own box list.
      expect(await sdk.getEscrows(instanceId)).toEqual([escrow])
    })

    test('multiple escrows accumulate in order and the counter tracks the list length', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrows = [newEscrow(), newEscrow(), newEscrow()]

      for (const account of escrows) {
        await sdk.registry.registerEscrow({ instanceNumId: instanceId, account })
      }

      expect(await sdk.getEscrows(instanceId)).toEqual(escrows)
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(BigInt(escrows.length))
      for (const account of escrows) {
        expect(await sdk.getEscrowInstance(account)).toBe(Number(instanceId))
      }
    })

    test('rejects an escrow already assigned to the same instance', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: escrow })
      await expect(sdk.registry.registerEscrow({ instanceNumId: instanceId, account: escrow })).rejects.toThrow(
        transformedError(errEscrowAssigned),
      )
    })

    test('enforces globally-unique assignment across instances', async () => {
      const { testAccount } = localnet.context
      // Two instances spawned from the same registry.
      const { sdk, instanceId: firstInstanceId } = await deployFracInstance(localnet, testAccount)
      const { instanceId: secondInstanceId } = await deployFracInstance(localnet, testAccount, {
        registrySdk: sdk.registry,
        name: 'second',
      })
      const escrow = newEscrow()

      await sdk.registry.registerEscrow({ instanceNumId: firstInstanceId, account: escrow })

      // Same escrow cannot be reassigned to a different instance.
      await expect(sdk.registry.registerEscrow({ instanceNumId: secondInstanceId, account: escrow })).rejects.toThrow(
        transformedError(errEscrowAssigned),
      )
      // The original assignment is unchanged.
      expect(await sdk.getEscrowInstance(escrow)).toBe(Number(firstInstanceId))
    })

    test('rejects registration against a non-existent instance', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)

      await expect(sdk.registry.registerEscrow({ instanceNumId: 9999, account: newEscrow() })).rejects.toThrow(
        transformedError(errInstanceAppNotExists),
      )
    })

    test('non-admin cannot register an escrow', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const { sdk: nonAdminSdk } = await generateAccountWithFracRegSDK(localnet, sdk.appId, (3).algos())

      await expect(nonAdminSdk.registerEscrow({ instanceNumId: instanceId, account: newEscrow() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  describe('registry registerEscrows (batched)', () => {
    test('one group registers the whole batch, in order, with the counter tracking it', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrows = Array.from({ length: MAX_ESCROWS_PER_REGISTER_GROUP }, newEscrow)

      await sdk.registry.registerEscrows({ instanceNumId: instanceId, accounts: escrows })

      // Same end state as registering them one at a time, which is the point of the batch.
      expect(await sdk.getEscrows(instanceId)).toEqual(escrows)
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(BigInt(escrows.length))
      for (const account of escrows) {
        expect(await sdk.getEscrowInstance(account)).toBe(Number(instanceId))
      }
    })

    test('the group is atomic: one already-assigned escrow registers none of the batch', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const taken = newEscrow()
      await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: taken })
      const batch = [newEscrow(), taken, newEscrow()]

      await expect(sdk.registry.registerEscrows({ instanceNumId: instanceId, accounts: batch })).rejects.toThrow(
        transformedError(errEscrowAssigned),
      )

      // Only the escrow registered before the batch survives — the two fresh ones rolled back with it.
      expect(await sdk.getEscrows(instanceId)).toEqual([taken])
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(1n)
      expect(await sdk.getEscrowInstance(batch[0])).toBeUndefined()
      expect(await sdk.getEscrowInstance(batch[2])).toBeUndefined()
    })

    test('rejects an oversized batch client-side, before anything is sent', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrows = Array.from({ length: MAX_ESCROWS_PER_REGISTER_GROUP + 1 }, newEscrow)

      await expect(sdk.registry.registerEscrows({ instanceNumId: instanceId, accounts: escrows })).rejects.toThrow(
        /exceeds the .* per group/,
      )
      expect(await sdk.getEscrows(instanceId)).toEqual([])
    })

    test('rejects an empty batch', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)

      await expect(sdk.registry.registerEscrows({ instanceNumId: instanceId, accounts: [] })).rejects.toThrow(
        /no accounts to register/,
      )
    })

    test('registerEscrowsAll spans several groups against a growing escrows box', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount)
      // Enough for several groups, so the later ones run against an escrows box that earlier groups
      // grew — the case a single group can never reach.
      const escrows = Array.from({ length: MAX_ESCROWS_PER_REGISTER_GROUP * 5 }, newEscrow)
      // The instance is spawned with DEFAULT_INSTANCE_MBR_MICROALGOS, which covers its 100k account
      // MBR and box growth up to 69 escrows. Fund it so MBR cannot mask an unrelated failure.
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(appId), (5).algos())

      await sdk.registry.registerEscrowsAll({ instanceNumId: instanceId, accounts: escrows })

      expect(await sdk.getEscrows(instanceId)).toEqual(escrows)
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(BigInt(escrows.length))
    })
  })

  describe('instance registerEscrow (direct)', () => {
    test('admin escape hatch: direct instance call appends to the list but bypasses the registry counter', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      // Admin (the resolved registry admin) calls the instance directly.
      await sdk.registerInstanceEscrow({ instanceNumId: instanceId, account: escrow })

      expect(await sdk.getEscrows(instanceId)).toEqual([escrow])
      // The registry was not involved, so its assignment map and counter are untouched.
      expect(await sdk.getEscrowInstance(escrow)).toBeUndefined()
      expect((await sdk.registry.getInstance(instanceId))!.numEscrows).toBe(0n)
    })

    test('a non-admin, non-registry caller cannot register an escrow on the instance', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const { sdk: nonAdminSdk } = await generateAccountWithFracSDK(localnet, sdk.appId)

      await expect(
        nonAdminSdk.registerInstanceEscrow({ instanceNumId: instanceId, account: newEscrow() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })

  describe('registry getEscrow', () => {
    test('an unassigned escrow reads back as the zero sentinel, surfaced as undefined', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      // Raw readonly: the contract must answer with a sentinel, not a failure — importFracDelegations
      // relies on this staying a plain read and enforces "assigned" itself.
      const { return: raw } = await sdk.registry.readClient.send.getEscrow({ args: { account: escrow } })
      expect(raw!.instanceNumId).toBe(0)
      expect(raw!.instanceAppId).toBe(0n)

      expect(await sdk.registry.getEscrow(escrow)).toBeUndefined()
    })

    test('a registered escrow resolves to its instance numeric id and app id', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: escrow })

      expect(await sdk.registry.getEscrow(escrow)).toEqual({
        instanceNumId: Number(instanceId),
        instanceAppId: appId,
      })
      // Agrees with the plain box read, which resolves the numeric id only.
      expect(await sdk.getEscrowInstance(escrow)).toBe(Number(instanceId))
    })
  })
})
