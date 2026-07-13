import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGORAND_ZERO_ADDRESS_STRING } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { errUnauthorized } from '../base/errors.algo'
import { createFracSDK, deployFracRegistry, generateAccountWithFracSDK, transformedError } from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('FracDelegationRegistry admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // Infrastructure
  describe('deployment configuration', () => {
    // FracDelegationRegistrySDK.createRegistry() is the production deploy path. It hard-codes
    // extraProgramPages: 3 so the approval program can grow toward the AVM ceiling without
    // ever needing a redeploy. The registry's global schema is declared by the contract itself
    // and sits exactly at the AVM hard cap of 64 (44 uints + 20 bytes); these two assertions
    // guard against either drifting silently on a contract change.
    test('registry deploys with extraProgramPages=3 and a global schema summing to 64', async () => {
      const { testAccount: admin } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (10).algos())
      const { appClient } = await FracDelegationRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
      })

      const appInfo = await localnet.algorand.app.getById(appClient.appId)
      expect(appInfo.extraProgramPages).toBe(3)
      expect(appInfo.globalInts + appInfo.globalByteSlices).toBe(64)
    })

    test('createRegistry applies optional configuration and initial funding', async () => {
      const { testAccount: admin } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (10).algos())
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const initialFundingAlgos = 2
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

  describe('admin transfer and lifecycle', () => {
    test('admin and default operator default to creator; gGov registry app starts unset', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      expect(await sdk.getAdmin()).toBe(testAccount.toString())
      expect(await sdk.getDefaultOperator()).toBe(testAccount.toString())
      expect(await sdk.getGGovRegistryApp()).toBeUndefined()
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
      const newAdminSDK = createFracSDK(localnet, sdk.appId, newAdmin)
      await expect(newAdminSDK.setDefaultOperator({ newDefaultOperator: newAdmin.toString() })).resolves.toBeDefined()
    })

    test('admin can update the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(
        sdk.readClient.send.update.bare({ sender: testAccount.toString(), signer: testAccount.signer }),
      ).resolves.toBeDefined()
    })

    test('admin can delete the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.deleteApplication({})).resolves.toBeDefined()
    })
  })

  describe('withdrawALGO', () => {
    test('withdrawing to the zero address fails', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await expect(sdk.withdrawALGO({ receiver: ALGORAND_ZERO_ADDRESS_STRING, amount: 1n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

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
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithFracSDK(localnet, sdk.appId))
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

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawALGO({ receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot update the registry app', async () => {
      await expect(
        sdk.readClient.send.update.bare({
          sender: nonAdmin.toString(),
          signer: nonAdmin.signer,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the registry app', async () => {
      await expect(nonAdminSDK.deleteApplication({})).rejects.toThrow(transformedError(errUnauthorized))
    })
  })
})
