import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceFactory, FracDelegationRegistryFactory } from 'frac-delegation-sdk'
import { errInstanceAppNotConfigured, errInstanceNameTooLong, errUnauthorized } from '../base/errors.algo'
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
import instanceArc56 from '../artifacts/frac-delegation/FracDelegationInstance.arc56.json'
import { extraProgramPages } from '../../../frac-delegation-sdk/src/util/extraProgramPages'

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
      expect(Number(appInfo.extraProgramPages)).toBe(
        extraProgramPages(
          Buffer.from(instanceArc56.byteCode!.approval, 'base64'),
          Buffer.from(instanceArc56.byteCode!.clear, 'base64'),
        ),
      )

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

    // The name is embedded in every `FracInstanceCommitteeStanding`, and `logInstanceCommittees`
    // emits one per instance as a single AVM log - capped at 1024 bytes. Without a bound at
    // creation, one long-named instance would fail every pooled-voting page of this registry.
    test('rejects a name over the 64-byte cap, accepts one at it', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.addInstance({ name: 'x'.repeat(65) })).rejects.toThrow(transformedError(errInstanceNameTooLong))
      const atCap = 'x'.repeat(64)
      const instanceId = await sdk.addInstance({ name: atCap })
      expect((await sdk.getInstance(instanceId))!.name).toBe(atCap)
    })

    test('rejects when instance approval program not uploaded', async () => {
      const { testAccount } = localnet.context
      const sdk = await deployRegistryWithoutBytecode(localnet, testAccount)
      await expect(sdk.addInstance({ name: 'no-bytecode' })).rejects.toThrow(
        transformedError(errInstanceAppNotConfigured),
      )
    })
  })

  describe('requestMBR', () => {
    // requestMBR is a public ABI method with no admin gate: an instance calls it as an inner txn when
    // writing a box leaves it below its minimum balance. The only thing stopping an arbitrary
    // caller from making the registry pay out is the callerApplicationId check.

    /** Available balance of the registry vault — what `requestMBR` pays out of. */
    const vaultAvailable = async (localnet: AlgorandFixture, address: string) => {
      const info = await localnet.algorand.account.getInformation(address)
      return info.balance.microAlgo - info.minBalance.microAlgo
    }

    test('a direct call cannot make the vault pay out, even naming a real instance', async () => {
      const { testAccount } = localnet.context
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount)
      const vault = sdk.registryReadClient.appAddress.toString()
      const before = await vaultAvailable(localnet, vault)

      await expect(
        sdk.registry.writeClient!.send.requestMbr({
          args: { instanceNumId: Number(instanceId) },
          sender: testAccount.toString(),
          signer: testAccount.signer,
          extraFee: (1000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))

      expect(await vaultAvailable(localnet, vault)).toBe(before)
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
