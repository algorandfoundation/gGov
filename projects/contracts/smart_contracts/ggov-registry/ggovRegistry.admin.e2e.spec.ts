import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovRegistrySDK, GGovCommitteeFile } from 'ggov-sdk'
import { errRegistryMissing, errUnauthorized } from '../base/errors.algo'
import { createSDK, deployRegistry, generateAccountWithSDK, transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
import { configureTestLogging } from '../test-utils'

describe('GGovRegistry admin', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // Infrastructure
  describe('deployment configuration', () => {
    // GGovRegistrySDK.createRegistry() is the production deploy path. It hard-codes
    // extraProgramPages: 3 so the approval program can grow toward the AVM ceiling
    // without ever needing a redeploy. The registry's global schema is declared by the
    // contract itself and sits exactly at the AVM hard cap of 64 (44 uints + 20 bytes);
    // these two assertions guard against either drifting silently on a contract change.
    test('registry deploys with extraProgramPages=3 and a global schema summing to 64', async () => {
      const { testAccount: admin } = localnet.context
      // createRegistry pays the registry MBR + box MBR + initial funding out of the
      // deployer's balance; top the test admin up so it can cover the transfers + fees.
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const { appClient } = await GGovRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
      })

      const appInfo = await localnet.algorand.app.getById(appClient.appId)
      expect(appInfo.extraProgramPages).toBe(3)
      expect(appInfo.globalInts + appInfo.globalByteSlices).toBe(64)
    })

    test('createRegistry applies optional configuration', async () => {
      // note: normally frac registry will be deployed after ggov registry, but this test exercises the config
      const { testAccount: admin } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const { sdk } = await GGovRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
        operatorAccount: operator,
        xGovRegistryAppId: 12345n,
        fracRegistryAppId: 67890n,
      })

      expect(await sdk.readClient.state.global.operator()).toBe(operator.toString())
      expect(await sdk.readClient.state.global.xGovRegistryApp()).toBe(12345n)
      expect(await sdk.readClient.state.global.fracRegistryApp()).toBe(67890n)
    })
  })

  // Admin configs and management
  describe('setOperator', () => {
    test('admin can set the operator', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })
      expect(await sdk.readClient.state.global.operator()).toBe(operator.toString())
    })
  })

  describe('setXGovRegistryApp', () => {
    test('admin can set the xGov registry app id', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      // Key is initialized to 0 on deploy, so it reads back 0n until the admin sets it.
      expect(await sdk.readClient.state.global.xGovRegistryApp()).toBe(0n)

      await sdk.setXGovRegistryApp({ appId: 12345n })
      expect(await sdk.readClient.state.global.xGovRegistryApp()).toBe(12345n)
    })

    test('admin cannot mirrorXGovDelegation while the xGov registry app id is unset', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const account = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await expect(sdk.mirrorXGovDelegation({ account: account.toString() })).rejects.toThrow(
        transformedError(errRegistryMissing),
      )
    })
  })

  describe('setFracRegistryApp', () => {
    test('admin can set the frac-delegation registry app id', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      // Key is initialized to 0 on deploy, so it reads back 0n until the admin sets it.
      expect(await sdk.readClient.state.global.fracRegistryApp()).toBe(0n)

      await sdk.setFracRegistryApp({ appId: 12345n })
      expect(await sdk.readClient.state.global.fracRegistryApp()).toBe(12345n)
    })

    test('admin cannot importFracDelegations while the frac registry app id is unset', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const escrow = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await expect(sdk.importFracDelegations({ escrowAccounts: [escrow.toString()] })).rejects.toThrow(
        transformedError(errRegistryMissing),
      )

      // The guard precedes the per-escrow checks, so it also fires on an empty batch.
      await expect(sdk.importFracDelegations({ escrowAccounts: [] })).rejects.toThrow(
        transformedError(errRegistryMissing),
      )
    })
  })

  describe('admin transfer and lifecycle', () => {
    test('admin defaults to creator on deploy', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const admin = await sdk.getAdmin()
      expect(admin).toBe(testAccount.toString())
    })

    test('admin can transfer to new admin and old admin loses access', async () => {
      const { testAccount } = localnet.context
      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployRegistry(localnet, testAccount)

      await sdk.setAdmin({ newAdmin: newAdmin.toString() })
      expect(await sdk.getAdmin()).toBe(newAdmin.toString())

      // old admin can no longer call admin-gated methods
      await expect(
        sdk.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))

      // new admin can call admin-gated methods (use setOperator as a simple no-side-effect example)
      const newAdminSDK = createSDK(localnet, sdk.appId, newAdmin)
      await expect(newAdminSDK.setOperator({ account: newAdmin.toString() })).resolves.toBeDefined()
    })

    test('admin can update the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.updateApplication({})).resolves.toBeDefined()
    })

    test('admin can delete the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.deleteApplication({})).resolves.toBeDefined()
    })
  })

  describe('withdrawALGO', () => {
    test('admin can withdraw ALGO to a receiver', async () => {
      const { testAccount } = localnet.context
      // deployRegistry funds the app account with 10 ALGO
      const { sdk } = await deployRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const registryBefore = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      const amount = (3).algos().microAlgo

      await sdk.withdrawALGO({ receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      const registryAfter = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      // Receiver does not pay the fees (sender/admin does), so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
      // Registry loses `amount` (the inner-payment fee is paid by the outer txn sender).
      expect(registryAfter.balance.microAlgo).toBe(registryBefore.balance.microAlgo - amount)
    })

    test('withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // App holds ~10 ALGO; ask for far more than the balance minus min balance.
      await expect(
        sdk.withdrawALGO({ receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })
  })

  // Auth
  describe('admin auth', () => {
    let sdk: GGovRegistrySDK
    let nonAdmin: Awaited<ReturnType<typeof localnet.context.generateAccount>>
    let nonAdminSDK: GGovRegistrySDK

    beforeAll(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      ;({ sdk } = await deployRegistry(localnet, testAccount))
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithSDK(localnet, sdk.appId))
    })

    test('non-admin cannot unregisterCommittee', async () => {
      await expect(nonAdminSDK.unregisterCommittee({ committeeId: new Uint8Array(32) })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot registerCommittee', async () => {
      await expect(
        nonAdminSDK.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot ingestGovs', async () => {
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      await expect(
        nonAdminSDK.ingestGovs({
          committeeId,
          govs: [{ account: nonAdmin.toString(), votes: 10 }],
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot uningestGovs', async () => {
      const govAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: [{ address: govAccount.toString(), votes: 10 }],
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)
      await expect(nonAdminSDK.uningestGovs({ committeeId, govs: [govAccount.toString()] })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot mirrorXGovDelegation', async () => {
      const govAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(nonAdminSDK.mirrorXGovDelegation({ account: govAccount.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot importFracDelegations', async () => {
      await expect(nonAdminSDK.importFracDelegations({ escrowAccounts: [nonAdmin.toString()] })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot setAdmin', async () => {
      await expect(nonAdminSDK.setAdmin({ newAdmin: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawALGO({ receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot set the xGov registry app id', async () => {
      await expect(nonAdminSDK.setXGovRegistryApp({ appId: 12345n })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot set the frac-delegation registry app id', async () => {
      await expect(nonAdminSDK.setFracRegistryApp({ appId: 12345n })).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot setOperator', async () => {
      await expect(nonAdminSDK.setOperator({ account: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot uploadPeriodApprovalPartial', async () => {
      await expect(
        nonAdminSDK.uploadPeriodApprovalPartial({ startOffset: 0n, data: new Uint8Array([0x01]) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot setLastPeriodId', async () => {
      await expect(nonAdminSDK.setLastPeriodId({ newLastPeriodId: 0n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot update the registry app', async () => {
      await expect(nonAdminSDK.updateApplication({})).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the registry app', async () => {
      await expect(
        sdk.readClient.send.delete.bare({
          sender: nonAdmin.toString(),
          signer: nonAdmin.signer,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })

  describe('verifyAdmin / verifyOperator', () => {
    let sdk: GGovRegistrySDK
    let admin: string
    let operator: string
    let other: string

    beforeAll(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      admin = testAccount.toString()
      ;({ sdk } = await deployRegistry(localnet, testAccount))
      const operatorAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const otherAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      operator = operatorAccount.toString()
      other = otherAccount.toString()
      await sdk.setOperator({ account: operator })
    })

    test('verifyAdmin returns true for the admin and false for any other account', async () => {
      const { return: isAdmin } = await sdk.readClient.send.verifyAdmin({ args: { account: admin } })
      expect(isAdmin).toBe(true)
      const { return: isAdminOther } = await sdk.readClient.send.verifyAdmin({ args: { account: other } })
      expect(isAdminOther).toBe(false)
    })

    test('verifyOperator returns true for the operator and false for any other account', async () => {
      const { return: isOperator } = await sdk.readClient.send.verifyOperator({ args: { account: operator } })
      expect(isOperator).toBe(true)
      const { return: isOperatorOther } = await sdk.readClient.send.verifyOperator({ args: { account: other } })
      expect(isOperatorOther).toBe(false)
    })
  })
})
