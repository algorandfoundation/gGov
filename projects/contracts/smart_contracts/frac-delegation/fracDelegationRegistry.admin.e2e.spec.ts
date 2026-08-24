import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGORAND_ZERO_ADDRESS_STRING } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationInstanceFactory, FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { errUnauthorized } from '../base/errors.algo'
import {
  createFracRegistrySDK,
  deployFracInstance,
  deployFracRegistry,
  generateAccountWithFracRegSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'
import registryArc56 from '../artifacts/frac-delegation/FracDelegationRegistry.arc56.json'

describe('FracDelegationRegistry admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // Infrastructure
  describe('deployment configuration', () => {
    // FracDelegationRegistrySDK.createRegistry() is the production deploy path. It hard-codes
    // extraProgramPages: 3 so the approval program can grow toward the AVM ceiling without
    // ever needing a redeploy. The registry's global schema is no longer declared by hand —
    // the contract dropped its stateTotals override, so puya infers it from the GlobalState
    // fields. Asserting the deployed app against the compiled app spec catches a create path
    // that stops matching what the contract actually declares.
    test('registry deploys with extraProgramPages=3 and the schema its app spec declares', async () => {
      const { testAccount: admin } = localnet.context
      // createRegistry pays the registry MBR + box MBR + initial funding out of the
      // deployer's balance; top the test admin up so it can cover the transfers + fees.
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const { appClient } = await FracDelegationRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
      })

      const appInfo = await localnet.algorand.app.getById(appClient.appId)
      expect(appInfo.extraProgramPages).toBe(3)
      expect({ ints: appInfo.globalInts, bytes: appInfo.globalByteSlices }).toEqual(registryArc56.state.schema.global)
    })

    test('createRegistry uploads the instance approval bytecode at bootstrap', async () => {
      const { testAccount: admin } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const { appClient } = await FracDelegationRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
      })

      // The uploaded box must match this build's compiled instance approval program.
      const instanceFactory = localnet.algorand.client.getTypedAppFactory(FracDelegationInstanceFactory, {
        defaultSender: admin,
        defaultSigner: localnet.algorand.account.getSigner(admin),
      })
      const compiled = await instanceFactory.appFactory.compile()
      const box = await localnet.algorand.app.getBoxValue(appClient.appId, 'Iap')
      expect(box).toEqual(compiled.approvalProgram)
    })

    test('createRegistry applies optional configuration and initial funding', async () => {
      const { testAccount: admin } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // Must cover the registry's min balance through the bytecode uploads inside createRegistry —
      // the Iap box MBR grows with the instance approval program (vote() pushed it past 2 ALGO).
      const initialFundingAlgos = 3
      const gGovRegistryAppId = 12345n

      const { sdk, appClient } = await FracDelegationRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
        defaultOperatorAccount: operator,
        gGovRegistryAppId,
        initialFundingAlgos,
      })

      const appAccount = await localnet.algorand.account.getInformation(appClient.appAddress)
      expect(await sdk.getDefaultOperator()).toBe(operator.toString())
      expect(await sdk.getGGovRegistryApp()).toBe(gGovRegistryAppId)
      expect(appAccount.balance.microAlgo).toBe(initialFundingAlgos.algos().microAlgo)
    })
  })

  // Admin configs and management
  describe('setDefaultOperator', () => {
    test('admin can set the default operator', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setDefaultOperator({ newDefaultOperator: operator.toString() })
      expect(await sdk.getDefaultOperator()).toBe(operator.toString())
    })

    test('admin can unset the default operator with the zero address', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await sdk.setDefaultOperator({ newDefaultOperator: ALGORAND_ZERO_ADDRESS_STRING })
      expect(await sdk.getDefaultOperator()).toBe(ALGORAND_ZERO_ADDRESS_STRING)
    })
  })

  describe('setGGovRegistryApp', () => {
    test('admin can set the gGov registry app id', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await sdk.setGGovRegistryApp({ appId: 12345n })
      expect(await sdk.getGGovRegistryApp()).toBe(12345n)
    })
  })

  describe('setMBRTopUp', () => {
    test('admin can set the MBR top-up amount', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      // 2 ALGO default, set at deploy by the global's initialValue.
      expect(await sdk.getMBRTopUp()).toBe(2_000_000n)

      await sdk.setMBRTopUp({ amount: 5_000_000n })
      expect(await sdk.getMBRTopUp()).toBe(5_000_000n)
    })
  })

  describe('admin transfer and lifecycle', () => {
    test('admin and default operator default to creator; gGov registry app starts unset (zero sentinel)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      expect(await sdk.getAdmin()).toBe(testAccount.toString())
      expect(await sdk.getDefaultOperator()).toBe(testAccount.toString())
      expect(await sdk.getGGovRegistryApp()).toBe(0n)
    })

    test('admin cannot transfer to the zero address', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.setAdmin({ newAdmin: ALGORAND_ZERO_ADDRESS_STRING })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('admin can transfer to new admin and old admin loses access', async () => {
      const { testAccount } = localnet.context
      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployFracRegistry(localnet, testAccount)

      await sdk.setAdmin({ newAdmin: newAdmin.toString() })
      expect(await sdk.getAdmin()).toBe(newAdmin.toString())

      // old admin can no longer call admin-gated methods
      await expect(sdk.setGGovRegistryApp({ appId: 12345n })).rejects.toThrow(transformedError(errUnauthorized))

      // new admin can call admin-gated methods
      const newAdminSDK = createFracRegistrySDK(localnet, sdk.appId, newAdmin)
      await expect(newAdminSDK.setDefaultOperator({ newDefaultOperator: newAdmin.toString() })).resolves.toBeDefined()
    })

    test('admin can update the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.updateApplication({})).resolves.toBeDefined()
    })

    test('admin can delete the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.deleteApplication({})).resolves.toBeDefined()
    })

    test('delete refuses while an instance it created is still bound to it, then succeeds once deleted', async () => {
      const { testAccount } = localnet.context
      const { sdk: registrySdk } = await deployFracRegistry(localnet, testAccount)
      const { sdk, instanceId } = await deployFracInstance(localnet, testAccount, { registrySdk })

      await expect(registrySdk.deleteApplication({})).rejects.toThrow(/still bound/)

      await sdk.deleteInstanceApp({ instanceNumId: instanceId })
      await expect(registrySdk.deleteApplication({})).resolves.toBeDefined()
    })
  })

  describe('withdrawALGO', () => {
    test('withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // App holds ~1 ALGO; ask for far more than the balance minus min balance.
      await expect(
        sdk.withdrawALGO({ receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })

    test('admin can withdraw ALGO to a receiver', async () => {
      const { testAccount } = localnet.context
      // deployFracRegistry funds the app account with 1 ALGO
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const registryBefore = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      const amount = (0.5).algos().microAlgo

      await sdk.withdrawALGO({ receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      const registryAfter = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      // Receiver does not pay the fees (sender/admin does), so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
      // Registry loses `amount` (the inner-payment fee is paid by the outer txn sender).
      expect(registryAfter.balance.microAlgo).toBe(registryBefore.balance.microAlgo - amount)
    })
  })

  // Auth
  describe('admin auth', () => {
    let sdk: FracDelegationRegistrySDK
    let nonAdmin: Awaited<ReturnType<typeof localnet.context.generateAccount>>
    let nonAdminSDK: FracDelegationRegistrySDK

    beforeAll(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      ;({ sdk } = await deployFracRegistry(localnet, testAccount))
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithFracRegSDK(localnet, sdk.appId))
      await localnet.algorand.account.ensureFundedFromEnvironment(nonAdmin, (25).algos())
    })

    test('non-admin cannot setAdmin', async () => {
      await expect(nonAdminSDK.setAdmin({ newAdmin: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot setDefaultOperator', async () => {
      await expect(nonAdminSDK.setDefaultOperator({ newDefaultOperator: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot set the gGov registry app id', async () => {
      await expect(nonAdminSDK.setGGovRegistryApp({ appId: 12345n })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot set the MBR top-up amount', async () => {
      await expect(nonAdminSDK.setMBRTopUp({ amount: 2_000_000n })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot uploadInstanceApprovalPartial', async () => {
      await expect(
        nonAdminSDK.uploadInstanceApprovalPartial({ startOffset: 0n, data: new Uint8Array([0x01]) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot createInstance', async () => {
      await expect(nonAdminSDK.addInstance({ name: 'Some Label' })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawALGO({ receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot update the registry app', async () => {
      await expect(nonAdminSDK.updateApplication({})).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the registry app', async () => {
      await expect(nonAdminSDK.deleteApplication({})).rejects.toThrow(transformedError(errUnauthorized))
    })
  })
})
