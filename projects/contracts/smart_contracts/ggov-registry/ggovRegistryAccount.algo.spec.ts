import { Account, Bytes, op } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errAccountExists, errAccountNotExists } from '../base/errors.algo'
import { GGovAccount } from '../base/types.algo'
import { u32 } from '../base/utils.algo'
import { GGovRegistryAccountContract } from './ggovRegistryAccount.algo'

// Expose subroutines for testing
class GGovRegistryAccountContractTest extends GGovRegistryAccountContract {
  declare public createAccount: (account: Account) => GGovAccount
  declare public getAccountIfExists: (account: Account) => GGovAccount
  declare public mustGetAccount: (account: Account) => GGovAccount
  declare public getOrCreateAccount: (account: Account) => GGovAccount
}

describe('[fast] GGovRegistryAccountContract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('createAccount', () => {
    it('Creates account id 1 for first account', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      const actual = contract.createAccount(account)

      const expected = u32(1)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
      expect(actual.committeeOffsets.length).toEqual(0)

      // test creates box
      const boxKey = Bytes`a`.concat(account.bytes)
      expect(ctx.ledger.boxExists(contract, boxKey)).toBe(true)

      // accountId is the first 4 bytes of the encoded GGovAccount struct
      const actualBoxAccountId = op.btoi(Bytes(ctx.ledger.getBox(contract, boxKey)).slice(0, 4))
      expect(actualBoxAccountId).toEqual(expected.asUint64())
    })

    it('Fails when trying to create account twice', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      contract.createAccount(account)
      expectArc65Error(ctx, () => contract.createAccount(account), errAccountExists)
    })
  })

  describe('getAccountIfExists', () => {
    it('Get account for nonexistent account returns id 0', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      const actual = contract.getAccountIfExists(account)

      const expected = u32(0)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
      expect(actual.committeeOffsets.length).toEqual(0)
    })

    it('Get account for existing account returns id', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      contract.createAccount(account)
      const actual = contract.getAccountIfExists(account)

      const expected = u32(1)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
    })
  })

  describe('mustGetAccount', () => {
    it('Get account for existing account returns id', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      contract.createAccount(account)
      const actual = contract.mustGetAccount(account)

      const expected = u32(1)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
    })

    it('Get account for nonexistent account throws', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      expectArc65Error(ctx, () => contract.mustGetAccount(account), errAccountNotExists)
    })
  })

  describe('getOrCreateAccount', () => {
    it('creates account if not exists', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      const actual = contract.getOrCreateAccount(account)

      const expected = u32(1)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
    })

    it('Reuses account if it exists', () => {
      const contract = ctx.contract.create(GGovRegistryAccountContractTest)
      const account = ctx.any.account()

      contract.getOrCreateAccount(account)

      const actual = contract.getOrCreateAccount(account)

      const expected = u32(1)
      expect(actual.accountId.asUint64()).toEqual(expected.asUint64())
    })
  })
})
