import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGORAND_ZERO_ADDRESS_STRING } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceSDK, FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { errAppGlobalKeyNotFound, errUnauthorized } from '../base/errors.algo'
import {
  deployFracInstance,
  deployFracRegistry,
  deployUnboundFracInstance,
  generateAccountWithFracInstanceSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('FracDelegationInstance admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // Infrastructure
  describe('deployment configuration', () => {
    // Standalone deployment (deployUnboundFracInstance + setRegistryApp) - in production instances
    // will be created via the registry.
    // TODO: re-target this block to the via-registry deploy path, analog to ggov period.
    test('instance deploys with extraProgramPages=3 and a global schema matching stateTotals', async () => {
      const { testAccount } = localnet.context
      const { client } = await deployFracInstance(localnet, testAccount)

      const appInfo = await localnet.algorand.app.getById(client.appId)
      expect(appInfo.extraProgramPages).toBe(3)
      expect(appInfo.globalInts).toBe(8)
      expect(appInfo.globalByteSlices).toBe(8)
    })
  })

  describe('standalone bootstrap', () => {
    // Standalone bootstrap: before the instance is bound to a registry. TODO: this whole block
    // retires together with the standalone deploy path once instances are created via the registry
    // (born bound through Global.callerApplicationId).
    test('fresh standalone instance has registryApp=0 and getAdmin fails with key-not-found', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployUnboundFracInstance(localnet, testAccount)

      expect(await sdk.getRegistryApp()).toBe(0n)
      // registryApp=0 means the getEx reads the instance's own state, where no `admin` key exists
      await expect(sdk.getAdmin()).rejects.toThrow(transformedError(errAppGlobalKeyNotFound))
    })

    test('while unbound, a non-creator cannot bind but the creator can', async () => {
      const { testAccount: creator } = localnet.context
      const { sdk } = await deployUnboundFracInstance(localnet, creator)
      const { sdk: registrySdk } = await deployFracRegistry(localnet, creator)
      const { sdk: nonCreatorSDK } = await generateAccountWithFracInstanceSDK(localnet, sdk.appId)

      await expect(nonCreatorSDK.setRegistryApp({ appId: registrySdk.appId })).rejects.toThrow(
        transformedError(errUnauthorized),
      )

      await sdk.setRegistryApp({ appId: registrySdk.appId })
      expect(await sdk.getRegistryApp()).toBe(registrySdk.appId)
    })
  })

  // Role resolution: reads from registry's global state
  describe('resolved roles', () => {
    test('getAdmin resolves through the registry, reflecting live changes to the registry admin', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, sdk } = await deployFracInstance(localnet, testAccount)
      expect(await sdk.getAdmin()).toBe(testAccount.toString())

      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await registrySdk.setAdmin({ newAdmin: newAdmin.toString() })
      expect(await sdk.getAdmin()).toBe(newAdmin.toString())
    })

    test('getOperator falls back to the registry defaultOperator when no local override is set', async () => {
      const { testAccount } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (10).algos())
      const signer = localnet.algorand.account.getSigner(testAccount)
      const defaultOperator = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const { sdk: registrySdk } = await FracDelegationRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: testAccount, signer },
        defaultOperatorAccount: defaultOperator,
      })
      const { sdk } = await deployUnboundFracInstance(localnet, testAccount)
      await sdk.setRegistryApp({ appId: registrySdk.appId })

      expect(await sdk.readClient.state.global.operator()).toBe(ALGORAND_ZERO_ADDRESS_STRING)
      expect(await sdk.getOperator()).toBe(defaultOperator.toString())
    })
  })

  // Admin configs and management
  describe('setOperator', () => {
    test('admin can set an instance local operator and clear it back to the registry fallback', async () => {
      const { testAccount } = localnet.context
      const { registrySdk, sdk } = await deployFracInstance(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await sdk.setOperator({ newOperator: operator.toString() })
      expect(await sdk.readClient.state.global.operator()).toBe(operator.toString())
      expect(await sdk.getOperator()).toBe(operator.toString())

      // The zero address clears the override, falling back to the registry default again.
      await sdk.setOperator({ newOperator: ALGORAND_ZERO_ADDRESS_STRING })
      expect(await sdk.readClient.state.global.operator()).toBe(ALGORAND_ZERO_ADDRESS_STRING)
      expect(await sdk.getOperator()).toBe(await registrySdk.getDefaultOperator())
    })
  })

  describe('setRegistryApp', () => {
    test('the registry admin can rebind to a second registry, and roles follow it', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)

      const secondRegistryCreator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const { sdk: secondRegistrySdk } = await deployFracRegistry(localnet, secondRegistryCreator)

      await sdk.setRegistryApp({ appId: secondRegistrySdk.appId })
      expect(await sdk.getRegistryApp()).toBe(secondRegistrySdk.appId)
      expect(await sdk.getAdmin()).toBe(secondRegistryCreator.toString())
      expect(await sdk.getOperator()).toBe(secondRegistryCreator.toString())

      // the first registry's admin lost admin over the instance
      await expect(sdk.setOperator({ newOperator: testAccount.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('rebinding to an app with no admin key bricks role resolution; only the creator can rebind back', async () => {
      const { testAccount: creator } = localnet.context
      const { registrySdk, sdk } = await deployFracInstance(localnet, creator)
      // Move the registry admin off-creator so the recovery below genuinely exercises the creator gate.
      const { account: admin, sdk: adminSDK } = await generateAccountWithFracInstanceSDK(localnet, sdk.appId)
      await registrySdk.setAdmin({ newAdmin: admin.toString() })

      // Bind the instance to itself: an existing app with no `admin` key, standing in for a dead
      // registry. (A nonexistent id is worse and unrecoverable: app_global_get_ex panics instead
      // of returning exists=false, so even setRegistryApp's own gate check fails.)
      await adminSDK.setRegistryApp({ appId: sdk.appId })
      await expect(sdk.getAdmin()).rejects.toThrow(transformedError(errAppGlobalKeyNotFound))

      const { sdk: recoveryRegistrySdk } = await deployFracRegistry(localnet, admin)

      // With no `admin` key to resolve, setRegistryApp falls back to the creator gate: the former
      // admin is locked out and only the creator can rebind to a live registry.
      await expect(adminSDK.setRegistryApp({ appId: sdk.appId })).rejects.toThrow(transformedError(errUnauthorized))
      await sdk.setRegistryApp({ appId: recoveryRegistrySdk.appId })
      expect(await sdk.getRegistryApp()).toBe(recoveryRegistrySdk.appId)
      expect(await sdk.getAdmin()).toBe(admin.toString())
    })
  })

  describe('lifecycle', () => {
    test('resolved admin can update, then delete the instance app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)

      await expect(
        sdk.readClient.send.update.bare({ sender: testAccount.toString(), signer: testAccount.signer }),
      ).resolves.toBeDefined()

      await sdk.deleteApplication({})
      await expect(localnet.algorand.app.getById(sdk.appId)).rejects.toThrow()
    })
  })

  describe('withdrawALGO', () => {
    test('admin can withdraw ALGO to a receiver; the zero address is rejected', async () => {
      const { testAccount } = localnet.context
      // deployFracInstance funds the instance app with 1 ALGO
      const { sdk } = await deployFracInstance(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const instanceBefore = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      const amount = (0.5).algos().microAlgo

      await sdk.withdrawALGO({ receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      const instanceAfter = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      // Receiver does not pay the fees (sender/admin does), so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
      // Instance loses `amount` (the inner-payment fee is paid by the outer txn sender).
      expect(instanceAfter.balance.microAlgo).toBe(instanceBefore.balance.microAlgo - amount)

      await expect(sdk.withdrawALGO({ receiver: ALGORAND_ZERO_ADDRESS_STRING, amount: 1n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracInstance(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // App holds ~1 ALGO; ask for far more than the balance minus min balance.
      await expect(
        sdk.withdrawALGO({ receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })
  })

  // Auth
  describe('admin auth', () => {
    let sdk: FracDelegationInstanceSDK
    let nonAdmin: Awaited<ReturnType<typeof localnet.context.generateAccount>>
    let nonAdminSDK: FracDelegationInstanceSDK

    beforeAll(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      ;({ sdk } = await deployFracInstance(localnet, testAccount))
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithFracInstanceSDK(localnet, sdk.appId))
    })

    test('non-admin cannot setOperator', async () => {
      await expect(nonAdminSDK.setOperator({ newOperator: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot set registry app ID', async () => {
      await expect(nonAdminSDK.setRegistryApp({ appId: 12345n })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawALGO({ receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot update the instance app', async () => {
      await expect(
        sdk.readClient.send.update.bare({
          sender: nonAdmin.toString(),
          signer: nonAdmin.signer,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the instance app', async () => {
      await expect(nonAdminSDK.deleteApplication({})).rejects.toThrow(transformedError(errUnauthorized))
    })
  })
})
