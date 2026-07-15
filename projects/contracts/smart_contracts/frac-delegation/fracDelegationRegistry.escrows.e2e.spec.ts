import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { generateAccount } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { errEscrowAssigned, errInstanceAppNotExists, errUnauthorized } from '../base/errors.algo'
import {
  deployFracInstance,
  generateAccountWithFracInstanceSDK,
  generateAccountWithFracRegSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

/** A fresh, unfunded address — escrows are stored as data, so they never need funding. */
const newEscrow = () => generateAccount().addr.toString()

describe('FracDelegationRegistry escrows', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('registry registerEscrow', () => {
    test('admin registers an escrow: assignment recorded, counter bumped, instance list appended', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      // Before: nothing assigned, empty list, zero counter.
      expect(await registrySdk.getEscrowInstance(escrow)).toBeUndefined()
      expect(await instanceSdk.getEscrows()).toEqual([])
      expect((await registrySdk.getInstance(instanceId))!.numEscrows).toBe(0n)

      await registrySdk.registerEscrow({ instanceNumId: instanceId, account: escrow })

      // Registry recorded the escrow -> instance assignment.
      expect(await registrySdk.getEscrowInstance(escrow)).toBe(Number(instanceId))
      // Instance counter mirrors the list length.
      expect((await registrySdk.getInstance(instanceId))!.numEscrows).toBe(1n)
      // Instance appended the escrow to its own box list.
      expect(await instanceSdk.getEscrows()).toEqual([escrow])
    })

    test('multiple escrows accumulate in order and the counter tracks the list length', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrows = [newEscrow(), newEscrow(), newEscrow()]

      for (const account of escrows) {
        await registrySdk.registerEscrow({ instanceNumId: instanceId, account })
      }

      expect(await instanceSdk.getEscrows()).toEqual(escrows)
      expect((await registrySdk.getInstance(instanceId))!.numEscrows).toBe(BigInt(escrows.length))
      for (const account of escrows) {
        expect(await registrySdk.getEscrowInstance(account)).toBe(Number(instanceId))
      }
    })

    test('rejects an escrow already assigned to the same instance', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      await registrySdk.registerEscrow({ instanceNumId: instanceId, account: escrow })
      await expect(registrySdk.registerEscrow({ instanceNumId: instanceId, account: escrow })).rejects.toThrow(
        transformedError(errEscrowAssigned),
      )
    })

    test('enforces globally-unique assignment across instances', async () => {
      const { testAccount } = localnet.context
      // Two instances spawned from the same registry.
      const { registrySdk, instanceId: firstInstanceId } = await deployFracInstance(localnet, testAccount)
      const { instanceId: secondInstanceId } = await deployFracInstance(localnet, testAccount, {
        registrySdk,
        name: 'second',
      })
      const escrow = newEscrow()

      await registrySdk.registerEscrow({ instanceNumId: firstInstanceId, account: escrow })

      // Same escrow cannot be reassigned to a different instance.
      await expect(registrySdk.registerEscrow({ instanceNumId: secondInstanceId, account: escrow })).rejects.toThrow(
        transformedError(errEscrowAssigned),
      )
      // The original assignment is unchanged.
      expect(await registrySdk.getEscrowInstance(escrow)).toBe(Number(firstInstanceId))
    })

    test('rejects registration against a non-existent instance', async () => {
      const { testAccount } = localnet.context
      const { registrySdk } = await deployFracInstance(localnet, testAccount)

      await expect(registrySdk.registerEscrow({ instanceNumId: 9999, account: newEscrow() })).rejects.toThrow(
        transformedError(errInstanceAppNotExists),
      )
    })

    test('non-admin cannot register an escrow', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const { sdk: nonAdminSdk } = await generateAccountWithFracRegSDK(localnet, registrySdk.appId, (3).algos())

      await expect(nonAdminSdk.registerEscrow({ instanceNumId: instanceId, account: newEscrow() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  describe('instance registerEscrow (direct)', () => {
    test('admin escape hatch: direct instance call appends to the list but bypasses the registry counter', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const escrow = newEscrow()

      // Admin (the resolved registry admin) calls the instance directly.
      await instanceSdk.registerEscrow({ account: escrow })

      expect(await instanceSdk.getEscrows()).toEqual([escrow])
      // The registry was not involved, so its assignment map and counter are untouched.
      expect(await registrySdk.getEscrowInstance(escrow)).toBeUndefined()
      expect((await registrySdk.getInstance(instanceId))!.numEscrows).toBe(0n)
    })

    test('a non-admin, non-registry caller cannot register an escrow on the instance', async () => {
      const { testAccount } = localnet.context
      const { sdk: instanceSdk } = await deployFracInstance(localnet, testAccount)
      const { sdk: nonAdminSdk } = await generateAccountWithFracInstanceSDK(localnet, instanceSdk.appId)

      await expect(nonAdminSdk.registerEscrow({ account: newEscrow() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })
})
