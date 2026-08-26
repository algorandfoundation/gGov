import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, it } from 'vitest'
import { BaseContract } from './base.algo'
import { expectArc65Error } from './common-tests'
import { errUnauthorized } from './errors.algo'

// Expose subroutines for testing
class BaseContractTest extends BaseContract {
  declare public ensureCallerIsAdmin: () => void
}

describe('[fast] BaseContract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('ensureCallerIsAdmin', () => {
    it('ensureCallerIsAdmin passes for creator', () => {
      const contract = ctx.contract.create(BaseContractTest)
      contract.ensureCallerIsAdmin()
    })

    it('ensureCallerIsAdmin fails for non-creator', async () => {
      const contract = ctx.contract.create(BaseContractTest)
      ctx.defaultSender = ctx.any.account() // change sender to non-creator
      expectArc65Error(ctx, () => contract.ensureCallerIsAdmin(), errUnauthorized)
    })
  })
})
