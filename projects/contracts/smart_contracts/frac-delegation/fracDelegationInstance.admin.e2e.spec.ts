import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGORAND_ZERO_ADDRESS_STRING } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceFactory, FracDelegationInstanceSDK } from 'frac-delegation-sdk'
import { errAppGlobalKeyNotFound, errUnauthorized } from '../base/errors.algo'
import {
  createFracInstanceSDK,
  deployFracInstance,
  deployFracRegistry,
  generateAccountWithFracInstanceSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('FracDelegationInstance admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

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
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployFracInstance(localnet, testAccount, { defaultOperator: operator })

      expect(await sdk.readClient.state.global.operator()).toBe(ALGORAND_ZERO_ADDRESS_STRING)
      expect(await sdk.getOperator()).toBe(operator.toString())
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
      const { testAccount: creator } = localnet.context
      const { registrySdk, sdk } = await deployFracInstance(localnet, creator)
      // Move the registry admin to a distinct account so the rebind is exercised by an admin
      // that is neither the deployer nor the instance creator (the spawning registry app).
      const { account: admin, sdk: adminSDK } = await generateAccountWithFracInstanceSDK(localnet, sdk.appId)
      await registrySdk.setAdmin({ newAdmin: admin.toString() })

      const secondRegistryCreator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const { sdk: secondRegistrySdk } = await deployFracRegistry(localnet, secondRegistryCreator)

      await adminSDK.setRegistryApp({ appId: secondRegistrySdk.appId })
      expect(await sdk.getRegistryApp()).toBe(secondRegistrySdk.appId)
      expect(await sdk.getAdmin()).toBe(secondRegistryCreator.toString())
      expect(await sdk.getOperator()).toBe(secondRegistryCreator.toString())

      // the first registry's admin lost admin over the instance
      await expect(adminSDK.setOperator({ newOperator: admin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
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
      // The instance's starting balance is the 1 ALGO MBR payment forwarded by createInstance
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

  describe('creator escape-hatch', () => {
    test('exercises the creator auth branch and registry setter on instances', async () => {
      // Deploy an unbounded instance
      const { testAccount: creator } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(creator, (10).algos())

      const factory = localnet.algorand.client.getTypedAppFactory(FracDelegationInstanceFactory, {
        defaultSender: creator,
        defaultSigner: localnet.algorand.account.getSigner(creator),
      })

      // The instance's create method is ABI-typed (createApplication(uint16,string)void), so the
      // standalone deploy passes the two create args the registry would normally supply.
      const { appClient } = await factory.send.create.createApplication({
        args: { instanceNumId: 0, name: 'standalone' },
        extraProgramPages: 3,
      })
      await localnet.algorand.send.payment({
        sender: creator,
        receiver: appClient.appAddress,
        amount: (1).algo(),
      })

      const sdk = createFracInstanceSDK(localnet, appClient.appId, creator)
      expect(await sdk.getRegistryApp()).toBe(0n)
      await expect(sdk.getAdmin()).rejects.toThrow(transformedError(errAppGlobalKeyNotFound))

      // Deploy a registry
      const { sdk: registrySdk } = await deployFracRegistry(localnet, creator)

      const { sdk: nonCreatorSDK } = await generateAccountWithFracInstanceSDK(localnet, sdk.appId)
      await expect(nonCreatorSDK.setRegistryApp({ appId: registrySdk.appId })).rejects.toThrow(
        transformedError(errAppGlobalKeyNotFound),
      )

      // Bound new registry to the instance
      await sdk.setRegistryApp({ appId: registrySdk.appId })
      expect(await sdk.getRegistryApp()).toBe(registrySdk.appId)

      // Cannot set an invalid registry (not `admin` key)
      await expect(sdk.setRegistryApp({ appId: sdk.appId })).rejects.toThrow(transformedError(errAppGlobalKeyNotFound))

      // Brick: deleting the bound registry kills role resolution (getEx on a nonexistent app
      // panics) - the scenario behind the registry deleteApplication WARNING.
      await registrySdk.deleteApplication({})
      await expect(sdk.getAdmin()).rejects.toThrow()

      // Hatch: only the creator branch of ensureCallerIsAdmin can still pass;
      // the creator rebinds to a fresh registry and roles resolve again.
      const recoveryCreator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const { sdk: recoveryRegistrySdk } = await deployFracRegistry(localnet, recoveryCreator)
      await sdk.setRegistryApp({ appId: recoveryRegistrySdk.appId })
      expect(await sdk.getAdmin()).toBe(recoveryCreator.toString())
    })
  })
})
