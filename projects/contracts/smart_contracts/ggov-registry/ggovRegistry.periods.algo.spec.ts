import { Uint64, type uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errGGovPeriodNotExists, errUnauthorized } from '../base/errors.algo'
import { getEmptyGGovPeriodSummary } from '../base/types.algo'
import { u32 } from '../base/utils.algo'
import { GGovRegistryContract } from './ggovRegistry.algo'

/** Seed a period summary box so requestMBR can validate the caller against it. */
const seedPeriod = (contract: GGovRegistryContract, periodId: Uint32, appId: uint64): void => {
  contract.periods(periodId).value = { ...getEmptyGGovPeriodSummary(), appId }
}

describe('[fast] GGovRegistryContract periods', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('requestMBR', () => {
    it('rejects a nonzero caller app that is not the registered period', () => {
      const contract = ctx.contract.create(GGovRegistryContract)
      const periodId = u32(1)
      seedPeriod(contract, periodId, ctx.any.application({ applicationId: 101 }).id)
      ctx.ledger.patchGlobalData({ callerApplicationId: ctx.any.application({ applicationId: 202 }).id })

      expectArc65Error(ctx, () => contract.requestMBR(periodId), errUnauthorized)
    })

    it('pays the current mbrTopUp to the period app', () => {
      const contract = ctx.contract.create(GGovRegistryContract)
      const periodId = u32(1)
      const periodApp = ctx.any.application({ applicationId: 101 })
      seedPeriod(contract, periodId, periodApp.id)
      ctx.ledger.patchGlobalData({ callerApplicationId: periodApp.id })

      contract.setMBRTopUp(Uint64(7_000_000))
      contract.requestMBR(periodId)

      const payment = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payment.amount).toEqual(Uint64(7_000_000))
      expect(payment.receiver).toEqual(periodApp.address)
    })

    it('rejects a period id that was never registered', () => {
      const contract = ctx.contract.create(GGovRegistryContract)
      expectArc65Error(ctx, () => contract.requestMBR(u32(999)), errGGovPeriodNotExists)
    })
  })
})
