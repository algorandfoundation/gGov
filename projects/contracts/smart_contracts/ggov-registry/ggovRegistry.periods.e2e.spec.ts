import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovPeriodFactory, GGovRegistryFactory, GGovCommitteeFile } from 'ggov-sdk'
import {
  errCommitteeIncomplete,
  errCommitteeNotExists,
  errPeriodAppNotConfigured,
  errPeriodEndLessThanStart,
  errPeriodInRange,
  errUnauthorized,
} from '../base/errors.algo'
import {
  createSDK,
  deployRegistry,
  deployRegistryWithCommittee,
  generateAccountWithSDK,
  transformedError,
} from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
import { configureTestLogging } from '../test-utils'

describe('GGovRegistry periods', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('createPeriod', () => {
    test('operator can create a period', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      expect(periodId).toBeGreaterThan(0n)
    })

    test('rejects mbrPayment sent to wrong receiver', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const wrongPayment = await localnet.algorand.createTransaction.payment({
        sender: testAccount.toString(),
        receiver: testAccount.toString(),
        amount: (1).algos(),
      })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.writeClient!.send.createPeriod({
          args: { committeeId, votingStart: now + 100n, votingEnd: now + 3700n, mbrPayment: wrongPayment },
          sender: testAccount.toString(),
          signer: testAccount.signer,
          extraFee: (3000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-operator cannot create a period', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const { sdk: nonOperatorSDK } = await generateAccountWithSDK(localnet, sdk.appId, (3).algos())
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        nonOperatorSDK.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects nonexistent committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId: new Uint8Array(32), votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('rejects incomplete committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setOperator({ account: testAccount.toString() })
      const committeeId = new Uint8Array(32).fill(1)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })).rejects.toThrow(
        transformedError(errCommitteeIncomplete),
      )
    })

    test('rejects votingEnd <= votingStart', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(sdk.addPeriod({ committeeId, votingStart: now + 3700n, votingEnd: now + 100n })).rejects.toThrow(
        transformedError(errPeriodEndLessThanStart),
      )
    })

    test('rejects when period approval program not uploaded', async () => {
      const { testAccount } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (25).algos())
      const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const { appClient: bareClient } = await factory.deploy({
        onUpdate: 'append',
        onSchemaBreak: 'append',
        createParams: { extraProgramPages: 3 },
      })
      await localnet.algorand.account.ensureFundedFromEnvironment(bareClient.appAddress, (10).algos())
      const sdk = createSDK(localnet, bareClient.appId, testAccount)
      const govAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeId = await sdk.uploadCommitteeFile({
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: [{ address: govAccount.toString(), votes: 10 }],
      })
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })).rejects.toThrow(
        transformedError(errPeriodAppNotConfigured),
      )
    })
  })

  describe('requestMBR', () => {
    // requestMBR is a public ABI method with no admin gate: a period calls it as an inner txn when
    // writing a vote record leaves it below its minimum balance. The only thing stopping an arbitrary
    // caller from making the registry pay out is the callerApplicationId check.

    /** Available balance of the registry vault — what `requestMBR` pays out of. */
    const vaultAvailable = async (address: string) => {
      const info = await localnet.algorand.account.getInformation(address)
      return info.balance.microAlgo - info.minBalance.microAlgo
    }

    test('a direct call cannot make the vault pay out, even naming a real period', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const vault = sdk.readClient.appAddress.toString()
      const before = await vaultAvailable(vault)

      await expect(
        sdk.writeClient!.send.requestMbr({
          args: { periodId: Number(periodId) },
          sender: testAccount.toString(),
          signer: testAccount.signer,
          extraFee: (1000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))

      expect(await vaultAvailable(vault)).toBe(before)
    })
  })

  describe('setLastPeriodId', () => {
    test('admin can set lastPeriodId when no periods exist in the affected range', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setLastPeriodId({ newLastPeriodId: 99n })
      expect(await sdk.readClient.state.global.lastPeriodId()).toBe(99n)
    })

    test('rejects when a period exists in the affected range', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      await sdk.addPeriod({ committeeId, votingStart: now + 3800n, votingEnd: now + 7400n })
      await expect(sdk.setLastPeriodId({ newLastPeriodId: 0n })).rejects.toThrow(transformedError(errPeriodInRange))
    })
  })

  describe('uploadPeriodApprovalProgram (SDK wrapper)', () => {
    // One-shot upload: the whole program rides in a single call as up to three 4094-byte pages.
    // 10000 bytes is past both ceilings at once: the 8188 two application arguments carry, and the
    // 8192 of box write budget the 8 references a single app call can hold buy. It exercises the
    // third page and the reference-carrying companion calls together.
    test('period approval box uploaded in one call spans three pages', async () => {
      const { testAccount } = localnet.context
      const { sdk, client } = await deployRegistry(localnet, testAccount)
      // A 10000-byte box costs ~4 ALGO of MBR, well past what the registry is deployed with.
      await localnet.algorand.account.ensureFundedFromEnvironment(client.appAddress, (10).algos())

      const bytecode = new Uint8Array(10000).map((_, i) => i % 251)
      await sdk.uploadPeriodApprovalProgram({ bytecode })

      const box = await localnet.algorand.app.getBoxValue(sdk.appId, 'Pap')
      expect(box).toEqual(bytecode)
    })

    test('period box uploaded in one call enables createPeriod', async () => {
      const { testAccount } = localnet.context
      // Deploy bare registry (no period bytecode) by bypassing the deployRegistry helper
      await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (25).algos())
      const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const { appClient: bareClient } = await factory.deploy({
        onUpdate: 'append',
        onSchemaBreak: 'append',
        createParams: { extraProgramPages: 3 },
      })
      await localnet.algorand.account.ensureFundedFromEnvironment(bareClient.appAddress, (10).algos())
      const sdk = createSDK(localnet, bareClient.appId, testAccount)

      const periodFactory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const compiled = await periodFactory.appFactory.compile()
      await sdk.uploadPeriodApprovalProgram({ bytecode: compiled.approvalProgram })

      // Verify the box was assembled correctly: createPeriod (addPeriod) must succeed
      const govAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: [{ address: govAccount.toString(), votes: 10 }],
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).resolves.toBeDefined()
    })
  })
})
