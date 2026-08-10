import { Application, Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint16 } from '@algorandfoundation/algorand-typescript/arc4'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errInstanceAppNotExists, errUnauthorized } from '../base/errors.algo'
import { u16 } from '../base/utils.algo'
import { FracDelegationRegistryContract } from './fracDelegationRegistry.algo'

/** Seed an instance box so requestMBR can validate the caller against it. */
const seedInstance = (contract: FracDelegationRegistryContract, instanceNum: Uint16, appId: Application): void => {
  contract.instances(instanceNum).value = {
    appId,
    name: 'inst',
    numAccounts: Uint64(0),
    numEscrows: Uint64(0),
  }
}

describe('[fast] FracDelegationRegistryContract instances', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('requestMBR', () => {
    it('rejects a nonzero caller app that is not the registered instance', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContract)
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, ctx.any.application({ applicationId: 101 }))
      ctx.ledger.patchGlobalData({ callerApplicationId: ctx.any.application({ applicationId: 202 }).id })

      expectArc65Error(ctx, () => contract.requestMBR(instanceNum), errUnauthorized)
    })

    it('pays the current mbrTopUp to the instance app', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContract)
      const instanceNum = u16(1)
      const instanceApp = ctx.any.application({ applicationId: 101 })
      seedInstance(contract, instanceNum, instanceApp)
      ctx.ledger.patchGlobalData({ callerApplicationId: instanceApp.id })

      contract.setMBRTopUp(Uint64(7_000_000))
      contract.requestMBR(instanceNum)

      const payment = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payment.amount).toEqual(Uint64(7_000_000))
      expect(payment.receiver).toEqual(instanceApp.address)
    })

    it('rejects an instance id that was never registered', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContract)
      expectArc65Error(ctx, () => contract.requestMBR(u16(999)), errInstanceAppNotExists)
    })
  })
})
