import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { increaseBudgetBaseCost, increaseBudgetIncrementCost } from 'xgov-delegator-sdk'
import { errAlgoHoursExist, errPeriodStartInvalid, errUnauthorized } from '../base/errors.algo'
import { deployDelegatorSimple, transformedError } from '../common-tests'

describe.skip('Delegator simple e2e tests', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      // debug: true,
      // traceAll: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  describe('increaseBudget opcode cost', () => {
    for (let i = 0; i < 3; i++) {
      test(`It should cost ${increaseBudgetBaseCost + i * increaseBudgetIncrementCost} with itxns=${i}`, async () => {
        const { testAccount } = localnet.context
        const sender = testAccount.toString()
        const signer = testAccount.signer

        const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)

        const {
          simulateResponse: {
            txnGroups: [{ appBudgetConsumed }],
          },
        } = await adminSDK
          .writeClient!.newGroup()
          .increaseBudget({ sender, signer, args: { itxns: BigInt(i) }, extraFee: (i * 1000).microAlgo() })
          .simulate()

        expect(appBudgetConsumed).toBe(increaseBudgetBaseCost + i * increaseBudgetIncrementCost) // if this fails then update the new value in SDK/constants
      })
    }
  })

  describe('setCommitteeOracleApp', () => {
    test(`Admin can set committee oracle app ID`, async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      const appId = 12345n
      await adminSDK.setCommitteeOracleApp({ appId })

      const { committeeOracleApp } = await adminSDK.getGlobalState()
      expect(committeeOracleApp).toBe(appId)
    })

    test(`Nonadmin can not set committee oracle app ID`, async () => {
      const { testAccount } = localnet.context
      const otherAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { userSDK } = await deployDelegatorSimple(localnet, testAccount, otherAccount)

      await expect(userSDK!.setCommitteeOracleApp({ appId: 12345n })).rejects.toThrowError(
        transformedError(errUnauthorized),
      )
    })
  })

  describe('addAccountAlgoHours', () => {
    const periodStart = 1_000_000n
    const account = 'DTHIRTEENNLSYGLSEXTXC6X4SVDWMFRCPAOAUCXWIXJRCVBWIIGLYARNQE'
    const algoHours = 100n

    test(`Admin can add account algo hours`, async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] })
    })

    test(`Admin can add account algo hours for multiple periods`, async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] })
      await adminSDK.addAccountAlgoHours({ periodStart: 2_000_000n, accountAlgohours: [{ account, algoHours }] })
    })

    test(`Nonadmin can not add algo hours`, async () => {
      const { testAccount } = localnet.context
      const otherAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { userSDK } = await deployDelegatorSimple(localnet, testAccount, otherAccount)
      await expect(
        userSDK!.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] }),
      ).rejects.toThrowError(transformedError(errUnauthorized))
    })

    test('It should fail if periodStart is not aligned to 1M', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      const invalidPeriodStart = 1_000_001n
      await expect(
        adminSDK.addAccountAlgoHours({ periodStart: invalidPeriodStart, accountAlgohours: [{ account, algoHours }] }),
      ).rejects.toThrowError(transformedError(errPeriodStartInvalid))
    })

    test('It should fail when adding more algohours to an existing period', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] })
      await expect(
        adminSDK.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] }),
      ).rejects.toThrowError(transformedError(errAlgoHoursExist))
    })
  })

  describe('getAccountAlgoHours', () => {
    const periodStart = 1_000_000n
    const account = 'DTHIRTEENNLSYGLSEXTXC6X4SVDWMFRCPAOAUCXWIXJRCVBWIIGLYARNQE'
    const algoHours = 100n

    test('It should return account algo hours for period', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({ periodStart, accountAlgohours: [{ account, algoHours }] })

      const returnedAlgoHours = await adminSDK.getAccountAlgoHours({ periodStart, account })
      expect(returnedAlgoHours).toBe(algoHours)
    })

    test('It should return 0 if account has no algo hours for period', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)

      const returnedAlgoHours = await adminSDK.getAccountAlgoHours({ periodStart, account })
      expect(returnedAlgoHours).toBe(0n)
    })

    test('It should fail if periodStart is not aligned to 1M', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      const invalidPeriodStart = 1_000_001n
      await expect(adminSDK.getAccountAlgoHours({ periodStart: invalidPeriodStart, account })).rejects.toThrowError(
        transformedError(errPeriodStartInvalid),
      )
    })
  })

  describe('getAlgoHourPeriodTotals', () => {
    const periodStart = 1_000_000n
    const account1 = 'DTHIRTEENNLSYGLSEXTXC6X4SVDWMFRCPAOAUCXWIXJRCVBWIIGLYARNQE'
    const account2 = 'ROBOTMMVHPOETOTAX3J26UXYKVZX6QB7FHHYGBC44JNBUXMTABD5I3CODE'
    const algoHours1 = 100n
    const algoHours2 = 100n

    test('It should return total algohours for period', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({
        periodStart,
        accountAlgohours: [{ account: account1, algoHours: algoHours1 }],
      })
      await adminSDK.addAccountAlgoHours({
        periodStart,
        accountAlgohours: [{ account: account2, algoHours: algoHours2 }],
      })

      const totalAlgoHours = await adminSDK.getAlgoHourPeriodTotals({ periodStart })
      expect(totalAlgoHours).toEqual({ totalAlgohours: algoHours1 + algoHours2, final: false })
    })

    test('It should return zero for unknown period', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({
        periodStart,
        accountAlgohours: [{ account: account1, algoHours: algoHours1 }],
      })

      const totalAlgoHours = await adminSDK.getAlgoHourPeriodTotals({ periodStart: 2_000_000n })
      expect(totalAlgoHours).toEqual({ totalAlgohours: 0n, final: false })
    })

    test('It should fail if periodStart is not aligned to 1M', async () => {
      const { testAccount } = localnet.context
      const { adminSDK } = await deployDelegatorSimple(localnet, testAccount)
      await adminSDK.addAccountAlgoHours({
        periodStart,
        accountAlgohours: [{ account: account1, algoHours: algoHours1 }],
      })

      await expect(adminSDK.getAlgoHourPeriodTotals({ periodStart: 2_000_001n })).rejects.toThrowError(
        transformedError(errPeriodStartInvalid),
      )
    })
  })
})
