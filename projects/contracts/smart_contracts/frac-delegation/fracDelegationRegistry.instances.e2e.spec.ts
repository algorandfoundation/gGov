import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceFactory, FracDelegationRegistryFactory } from 'frac-delegation-sdk'
import { errInstanceAppNotConfigured, errUnauthorized } from '../base/errors.algo'
import { Address, getApplicationAddress } from 'algosdk'
import {
  createFracRegistrySDK,
  deployFracInstance,
  deployFracRegistry,
  generateAccountWithFracRegSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'

const deployRegistryWithoutBytecode = async (localnet: AlgorandFixture, admin: Address) => {
  // Deploy bare registry (no period bytecode) by bypassing the deployRegistry helper
  await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
  const factory = localnet.algorand.client.getTypedAppFactory(FracDelegationRegistryFactory, {
    defaultSender: admin,
    defaultSigner: localnet.algorand.account.getSigner(admin),
  })
  const { appClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    createParams: { extraProgramPages: 3 },
  })
  await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (10).algos())
  return createFracRegistrySDK(localnet, appClient.appId, admin)
}

const compileInstanceApproval = async (localnet: AlgorandFixture, sender: Address) => {
  const instanceFactory = localnet.algorand.client.getTypedAppFactory(FracDelegationInstanceFactory, {
    defaultSender: sender,
    defaultSigner: localnet.algorand.account.getSigner(sender),
  })
  return (await instanceFactory.appFactory.compile()).approvalProgram
}

describe('FracDelegationRegistry instances', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('createInstance', () => {
    test('admin can create an instance', async () => {
      const { testAccount } = localnet.context
      const { sdk, appId, instanceId } = await deployFracInstance(localnet, testAccount)
      expect(instanceId).toBeGreaterThan(0n)

      const appInfo = await localnet.algorand.app.getById(appId)
      expect(appInfo.extraProgramPages).toBe(3)

      expect(await sdk.getInstanceRegistryApp(instanceId)).toBe(sdk.appId)
      expect(await sdk.getInstanceAdmin(instanceId)).toBe(testAccount.toString())

      // The paired MBR payment was forwarded in full to the spawned instance app account.
      const instanceAccount = await localnet.algorand.account.getInformation(getApplicationAddress(appId))
      expect(instanceAccount.balance.microAlgo).toBe((1).algos().microAlgo)
    })

    test('rejects mbrPayment sent to wrong receiver', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const wrongPayment = await localnet.algorand.createTransaction.payment({
        sender: testAccount.toString(),
        receiver: testAccount.toString(),
        amount: (1).algos(),
      })
      await expect(
        sdk.writeClient!.send.createInstance({
          args: { name: 'wrong-receiver', mbrPayment: wrongPayment },
          sender: testAccount.toString(),
          signer: testAccount.signer,
          extraFee: (2000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot create an instance', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const { sdk: nonAdminSDK } = await generateAccountWithFracRegSDK(localnet, sdk.appId, (3).algos())
      await expect(nonAdminSDK.addInstance({ name: 'unauthorized' })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects when instance approval program not uploaded', async () => {
      const { testAccount } = localnet.context
      const sdk = await deployRegistryWithoutBytecode(localnet, testAccount)
      await expect(sdk.addInstance({ name: 'no-bytecode' })).rejects.toThrow(
        transformedError(errInstanceAppNotConfigured),
      )
    })
  })

  describe('uploadInstanceApprovalProgram (SDK wrapper)', () => {
    // chunked upload - uploadInstanceApprovalPartial wrapper
    test('instance approval box assembled via chunks matches the uploaded bytecode', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)

      // Three chunks (2000 + 2000 + 1000): exercises box create (chunk 0) and resize (later chunks).
      const bytecode = new Uint8Array(5000).map((_, i) => i % 251)
      await sdk.uploadInstanceApprovalProgram({ bytecode })

      const box = await localnet.algorand.app.getBoxValue(sdk.appId, 'Iap')
      expect(box).toEqual(bytecode)
    })

    test('re-upload replaces prior bytecode', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)

      await sdk.uploadInstanceApprovalProgram({ bytecode: new Uint8Array(5000).fill(0xff) })

      // Re-upload the real (much smaller) compiled instance approval program: the box must
      // shrink to exactly the new bytes, with no residue from the larger prior upload.
      const compiled = await compileInstanceApproval(localnet, testAccount)
      await sdk.uploadInstanceApprovalProgram({ bytecode: compiled })

      const box = await localnet.algorand.app.getBoxValue(sdk.appId, 'Iap')
      expect(box).toEqual(compiled)
    })

    test('instance approval box assembled via chunks enables createInstance', async () => {
      const { testAccount: admin } = localnet.context
      // Deploy bare registry (no period bytecode) by bypassing the deployRegistry helper
      const sdk = await deployRegistryWithoutBytecode(localnet, admin)

      const compiled = await compileInstanceApproval(localnet, admin)
      await sdk.uploadInstanceApprovalProgram({ bytecode: compiled })

      // Verify the box was assembled correctly: createInstance (addInstance) must succeed from it.
      await expect(sdk.addInstance({ name: 'from-chunks' })).resolves.toBeDefined()
    })
  })
})
