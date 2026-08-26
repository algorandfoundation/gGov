import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errGGovLastOptionAbstain, errGGovNoOptions } from '../base/errors.algo'
import { GGovPeriodContract } from './ggovPeriod.algo'

// Expose subroutines for testing
class GGovPeriodContractTest extends GGovPeriodContract {
  declare public ensureValidOptions: (options: string[]) => void
}

describe('[fast] GGovPeriodContract', () => {
  const ctx = new TestExecutionContext()
  let contract: GGovPeriodContractTest

  beforeEach(() => {
    ctx.reset()
    contract = ctx.contract.create(GGovPeriodContractTest)
  })

  describe('ensureValidOptions', () => {
    it.each([
      { label: 'an empty list', options: [], err: errGGovNoOptions },
      { label: 'a last option that is not Abstain', options: ['Yes', 'No'], err: errGGovLastOptionAbstain },
      { label: 'Abstain in a non-final position', options: ['Abstain', 'Yes'], err: errGGovLastOptionAbstain },
      { label: 'Abstain more than once', options: ['Abstain', 'Yes', 'Abstain'], err: errGGovLastOptionAbstain },
      // The match is against the exact literal
      { label: 'a differently-cased abstain', options: ['Yes', 'No', 'abstain'], err: errGGovLastOptionAbstain },
    ])('Rejects $label', ({ options, err }) => {
      expectArc65Error(ctx, () => contract.ensureValidOptions(options), err)
    })

    it('Accepts a standard ballot', () => {
      expect(() => contract.ensureValidOptions(['Yes', 'No', 'Abstain'])).not.toThrow()
    })
  })
})
