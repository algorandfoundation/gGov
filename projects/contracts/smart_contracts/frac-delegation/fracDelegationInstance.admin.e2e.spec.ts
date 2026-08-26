import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGORAND_ZERO_ADDRESS_STRING, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceFactory, FracDelegationSDK, SIMULATE_PARAMS } from 'frac-delegation-sdk'
import { errRegistryMissing, errUnauthorized } from '../base/errors.algo'
import { deployFracInstance, deployFracRegistry, generateAccountWithFracSDK, transformedError } from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('FracDelegationInstance admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // Role resolution: reads from registry's global state
  describe('resolved roles', () => {
    test('getInstanceAdmin resolves through the registry, reflecting live changes to the registry admin', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      expect(await sdk.getInstanceAdmin(instanceId)).toBe(testAccount.toString())

      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.registry.setAdmin({ newAdmin: newAdmin.toString() })
      expect(await sdk.getInstanceAdmin(instanceId)).toBe(newAdmin.toString())
    })

    test('getInstanceOperator falls back to the registry defaultOperator when no local override is set', async () => {
      const { testAccount } = localnet.context
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount, { defaultOperator: operator })

      expect((await sdk.getInstanceGlobalState(instanceId)).operator).toBe(ALGORAND_ZERO_ADDRESS_STRING)
      expect(await sdk.getInstanceOperator(instanceId)).toBe(operator.toString())
    })
  })

  // Admin configs and management
  describe('setOperator', () => {
    test('admin can set an instance local operator and clear it back to the registry fallback', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await sdk.setOperator({ instanceNumId: instanceId, newOperator: operator.toString() })
      expect((await sdk.getInstanceGlobalState(instanceId)).operator).toBe(operator.toString())
      expect(await sdk.getInstanceOperator(instanceId)).toBe(operator.toString())

      // The zero address clears the override, falling back to the registry default again.
      await sdk.setOperator({ instanceNumId: instanceId, newOperator: ALGORAND_ZERO_ADDRESS_STRING })
      expect((await sdk.getInstanceGlobalState(instanceId)).operator).toBe(ALGORAND_ZERO_ADDRESS_STRING)
      expect(await sdk.getInstanceOperator(instanceId)).toBe(await sdk.registry.getDefaultOperator())
    })
  })

  describe('setRegistryApp', () => {
    test('the registry admin can rebind to a second registry, and roles follow it', async () => {
      const { testAccount: creator } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, creator)
      // Move the registry admin to a distinct account so the rebind is exercised by an admin
      // that is neither the deployer nor the instance creator (the spawning registry app).
      const { account: admin, sdk: adminSDK } = await generateAccountWithFracSDK(localnet, sdk.appId)
      await sdk.registry.setAdmin({ newAdmin: admin.toString() })

      const secondRegistryCreator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const { sdk: secondRegistrySdk } = await deployFracRegistry(localnet, secondRegistryCreator)

      await adminSDK.setRegistryApp({ instanceNumId: instanceId, appId: secondRegistrySdk.appId })
      expect(await sdk.getInstanceRegistryApp(instanceId)).toBe(secondRegistrySdk.appId)
      expect(await sdk.getInstanceAdmin(instanceId)).toBe(secondRegistryCreator.toString())
      expect(await sdk.getInstanceOperator(instanceId)).toBe(secondRegistryCreator.toString())

      // the first registry's admin lost admin over the instance
      await expect(adminSDK.setOperator({ instanceNumId: instanceId, newOperator: admin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  describe('lifecycle', () => {
    test('resolved admin can update, then delete the instance app', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount)

      await expect(sdk.updateInstanceApp({ instanceNumId: instanceId })).resolves.toBeDefined()

      await sdk.deleteInstanceApp({ instanceNumId: instanceId })
      await expect(localnet.algorand.app.getById(appId)).rejects.toThrow()
    })

    // TODO: unskip once FracDelegationInstanceContract.deleteApplication() actually cleans the
    // app balance (currently a no-op besides the admin check — see the TODO/commented-out
    // closeRemainderTo on the contract method).
    test.skip('delete sends the whole app balance to the caller', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount)
      const instanceAddress = getApplicationAddress(appId)
      // Fund the instance well above its base MBR so there's real escrow to recover.
      await localnet.algorand.send.payment({
        sender: testAccount,
        receiver: instanceAddress,
        amount: (2).algos(),
      })

      // TODO: add boxes as well

      const appBalanceBeforeDelete = (await localnet.algorand.account.getInformation(instanceAddress)).balance.microAlgo
      const adminBefore = await localnet.algorand.account.getInformation(testAccount)

      await sdk.deleteInstanceApp({ instanceNumId: instanceId })

      const adminAfter = await localnet.algorand.account.getInformation(testAccount)
      expect(adminAfter.balance.microAlgo).toBe(adminBefore.balance.microAlgo + appBalanceBeforeDelete - 2000n)
      await expect(localnet.algorand.app.getById(appId)).rejects.toThrow()
    })
  })

  describe('withdrawInstanceALGO', () => {
    test('admin can withdraw ALGO to a receiver', async () => {
      const { testAccount } = localnet.context
      // The instance's starting balance is the 1 ALGO MBR payment forwarded by createInstance
      const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount)
      const instanceAddress = getApplicationAddress(appId)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const instanceBefore = await localnet.algorand.account.getInformation(instanceAddress)
      const amount = (0.5).algos().microAlgo

      await sdk.withdrawInstanceALGO({ instanceNumId: instanceId, receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      const instanceAfter = await localnet.algorand.account.getInformation(instanceAddress)
      // Receiver does not pay the fees (sender/admin does), so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
      // Instance loses `amount` (the inner-payment fee is paid by the outer txn sender).
      expect(instanceAfter.balance.microAlgo).toBe(instanceBefore.balance.microAlgo - amount)
    })

    test('withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // App holds ~1 ALGO; ask for far more than the balance minus min balance.
      await expect(
        sdk.withdrawInstanceALGO({
          instanceNumId: instanceId,
          receiver: receiver.toString(),
          amount: (100).algos().microAlgo,
        }),
      ).rejects.toThrow()
    })
  })

  // Auth
  describe('admin auth', () => {
    let instanceId: bigint
    let nonAdmin: Awaited<ReturnType<typeof localnet.context.generateAccount>>
    let nonAdminSDK: FracDelegationSDK

    beforeAll(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      const { sdk, instanceId: id } = await deployFracInstance(localnet, testAccount)
      instanceId = id
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithFracSDK(localnet, sdk.appId))
    })

    test('non-admin cannot setOperator', async () => {
      await expect(
        nonAdminSDK.setOperator({ instanceNumId: instanceId, newOperator: nonAdmin.toString() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot set registry app ID', async () => {
      await expect(nonAdminSDK.setRegistryApp({ instanceNumId: instanceId, appId: 12345n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawInstanceALGO({
          instanceNumId: instanceId,
          receiver: nonAdmin.toString(),
          amount: (1).algos().microAlgo,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot update the instance app', async () => {
      await expect(nonAdminSDK.updateInstanceApp({ instanceNumId: instanceId })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot delete the instance app', async () => {
      await expect(nonAdminSDK.deleteInstanceApp({ instanceNumId: instanceId })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })
  })

  describe('creator escape-hatch', () => {
    test('exercises the creator auth branch and registry setter on instances', async () => {
      const { testAccount: creator } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(creator, (10).algos())

      // Deploy a registry (its SDK also registers the error transformer used by the asserts below)
      const { sdk: registrySdk } = await deployFracRegistry(localnet, creator)

      // Deploy an unbounded instance. It is recorded in no registry's instances box, so the
      // combined SDK cannot resolve it by instanceNumId — this scenario drives the instance app
      // through its generated client directly.
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

      const getRegistryApp = async () => BigInt((await appClient.state.global.registryApp())!)
      const getAdmin = async () =>
        (await appClient.newGroup().getAdmin({ args: {} }).simulate(SIMULATE_PARAMS)).returns[0]

      expect(await getRegistryApp()).toBe(0n)
      await expect(getAdmin()).rejects.toThrow(transformedError(errRegistryMissing))

      const nonCreator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        appClient.send.setRegistryApp({ args: { appId: registrySdk.appId }, sender: nonCreator }),
      ).rejects.toThrow(transformedError(errRegistryMissing))

      // Bound new registry to the instance
      await appClient.send.setRegistryApp({ args: { appId: registrySdk.appId } })
      expect(await getRegistryApp()).toBe(registrySdk.appId)

      // Cannot set an invalid registry (not `admin` key)
      await expect(appClient.send.setRegistryApp({ args: { appId: appClient.appId } })).rejects.toThrow(
        transformedError(errRegistryMissing),
      )

      // Brick: deleting the bound registry kills role resolution (getEx on a nonexistent app
      // panics) - the scenario behind the registry deleteApplication WARNING.
      await registrySdk.deleteApplication({})
      await expect(getAdmin()).rejects.toThrow()

      // Hatch: only the creator branch of ensureCallerIsAdmin can still pass;
      // the creator rebinds to a fresh registry and roles resolve again.
      const recoveryCreator = await localnet.context.generateAccount({ initialFunds: (10).algos() })
      const { sdk: recoveryRegistrySdk } = await deployFracRegistry(localnet, recoveryCreator)
      await appClient.send.setRegistryApp({ args: { appId: recoveryRegistrySdk.appId } })
      expect(await getAdmin()).toBe(recoveryCreator.toString())
    })
  })
})
