import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { GGovRegistrySDK, increaseBudgetBaseCost, increaseBudgetIncrementCost } from 'ggov-sdk'
import {
  increaseBudgetBaseCost as fracIncreaseBudgetBaseCost,
  increaseBudgetIncrementCost as fracIncreaseBudgetIncrementCost,
} from 'frac-delegation-sdk'
import { deployRegistry } from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('BaseContract e2e', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)

  // Pins the constants getIncreaseBudgetBuilder sizes itxn counts with — a cost drift would
  // under-provision budget. One representative deployment (ggov registry) guards all contracts.
  describe('increaseBudget opcode cost', () => {
    let sdk: GGovRegistrySDK
    beforeAll(async () => {
      await localnet.newScope()
      ;({ sdk } = await deployRegistry(localnet, localnet.context.testAccount))
    })
    for (let i = 0; i < 3; i++) {
      test(`It should cost ${increaseBudgetBaseCost + i * increaseBudgetIncrementCost} with itxns=${i}`, async () => {
        const { testAccount } = localnet.context
        const {
          simulateResponse: {
            txnGroups: [{ appBudgetConsumed }],
          },
        } = await sdk
          .writeClient!.newGroup()
          .increaseBudget({
            sender: testAccount.toString(),
            signer: testAccount.signer,
            args: { itxns: BigInt(i) },
            extraFee: (i * 1000).microAlgo(),
          })
          .simulate()
        expect(appBudgetConsumed).toBe(increaseBudgetBaseCost + i * increaseBudgetIncrementCost) // if this fails then update the new value in SDK/constants
      })
    }

    // frac-delegation-sdk carries a verbatim copy of the util and constants until the shared
    // SDK package lands; keep its copy in sync with the guarded values above.
    test('frac-delegation-sdk constants stay in sync with ggov-sdk', () => {
      expect(fracIncreaseBudgetBaseCost).toBe(increaseBudgetBaseCost)
      expect(fracIncreaseBudgetIncrementCost).toBe(increaseBudgetIncrementCost)
    })
  })
})
