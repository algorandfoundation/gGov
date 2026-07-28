import { Account, Application, Bytes, op, Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint16 } from '@algorandfoundation/algorand-typescript/arc4'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errInstanceAppNotExists, errUnauthorized } from '../base/errors.algo'
import { FracRegAccount } from '../base/types.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationRegistryContract } from './fracDelegationRegistry.algo'

// Expose the protected read subroutine for testing.
class FracDelegationRegistryContractTest extends FracDelegationRegistryContract {
  declare public getAccountIfExists: (account: Account) => FracRegAccount
}

/** Numeric IDs of the instances an account is associated with. */
const instanceIds = (account: FracRegAccount) => account.instanceNumIds.map((i) => i.asUint64())

/** Seed an instance box so getOrCreateAccountWithInstance can associate accounts with it. */
const seedInstance = (contract: FracDelegationRegistryContractTest, instanceNum: Uint16, appId: Application): void => {
  contract.instances(instanceNum).value = {
    appId,
    name: 'inst',
    numAccounts: Uint64(0),
    numEscrows: Uint64(0),
  }
}

describe('[fast] FracDelegationRegistryContract accounts', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('getAccount / getAccountIfExists', () => {
    it('getAccount returns zero accountId and no instances for an unknown account', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)

      const actual = contract.getAccount(ctx.any.account())

      expect(actual.accountId.asUint64()).toEqual(u32(0).asUint64())
      expect(actual.instanceNumIds.length).toEqual(0)
    })

    it('getAccountIfExists returns an empty struct for an unknown account', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)

      const actual = contract.getAccountIfExists(ctx.any.account())

      expect(actual.accountId.asUint64()).toEqual(u32(0).asUint64())
      expect(actual.instanceNumIds.length).toEqual(0)
    })

    it('getAccount returns the stored record for a known account', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const account = ctx.any.account()
      // Seed the account box directly (FracRegAccount is all arc4 types, so it round-trips).
      contract.accounts(account).value = { accountId: u32(7), instanceNumIds: [u16(1), u16(2)] }

      const actual = contract.getAccount(account)

      expect(actual.accountId.asUint64()).toEqual(u32(7).asUint64())
      expect(instanceIds(actual)).toEqual([u16(1).asUint64(), u16(2).asUint64()])

      // Box lives under the 'a' prefix; accountId is the leading 4 bytes of the encoded struct.
      const boxKey = Bytes`a`.concat(account.bytes)
      expect(ctx.ledger.boxExists(contract, boxKey)).toBe(true)
      const storedAccountId = op.btoi(Bytes(ctx.ledger.getBox(contract, boxKey)).slice(0, 4))
      expect(storedAccountId).toEqual(u32(7).asUint64())
    })
  })

  describe('getOrCreateAccountWithInstance', () => {
    it('rejects when the instance does not exist', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)

      expectArc65Error(
        ctx,
        () => contract.getOrCreateAccountWithInstance(ctx.any.account(), u16(1)),
        errInstanceAppNotExists,
      )
    })
  })

  // These exercise the account-creation and auth paths, which require getOrCreateAccountWithInstance to
  // clone() the FracInstance box, whose `appId: Application` reference field the old stable testing lib
  // (@algorandfoundation/algorand-typescript-testing@1.1.0) could not decode ("unsupported type
  // Application"). The 1.2.0 upgrade fixes that decode, so these run under the unit harness again.
  // The admin auth path and the reject-stranger case are also covered end-to-end in
  // fracDelegationRegistry.reader.e2e.spec.ts.
  describe('getOrCreateAccountWithInstance — creation & auth', () => {
    it('creates account id 1 and associates the instance', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceApp = ctx.any.application()
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, instanceApp)

      const account = ctx.any.account()
      ctx.defaultSender = instanceApp.address

      const actual = contract.getOrCreateAccountWithInstance(account, instanceNum)

      expect(actual.accountId.asUint64()).toEqual(u32(1).asUint64())
      expect(instanceIds(actual)).toEqual([u16(1).asUint64()])

      const boxKey = Bytes`a`.concat(account.bytes)
      expect(ctx.ledger.boxExists(contract, boxKey)).toBe(true)
      const storedAccountId = op.btoi(Bytes(ctx.ledger.getBox(contract, boxKey)).slice(0, 4))
      expect(storedAccountId).toEqual(u32(1).asUint64())
    })

    it('reuses the account and does not duplicate the instance on a repeat call', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceApp = ctx.any.application()
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, instanceApp)

      const account = ctx.any.account()
      ctx.defaultSender = instanceApp.address

      contract.getOrCreateAccountWithInstance(account, instanceNum)
      const actual = contract.getOrCreateAccountWithInstance(account, instanceNum)

      expect(actual.accountId.asUint64()).toEqual(u32(1).asUint64())
      expect(instanceIds(actual)).toEqual([u16(1).asUint64()])
    })

    it('adds a second instance to an existing account', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceAppA = ctx.any.application()
      const instanceAppB = ctx.any.application()
      seedInstance(contract, u16(1), instanceAppA)
      seedInstance(contract, u16(2), instanceAppB)

      const account = ctx.any.account()

      ctx.defaultSender = instanceAppA.address
      contract.getOrCreateAccountWithInstance(account, u16(1))

      ctx.defaultSender = instanceAppB.address
      const actual = contract.getOrCreateAccountWithInstance(account, u16(2))

      expect(actual.accountId.asUint64()).toEqual(u32(1).asUint64())
      expect(instanceIds(actual)).toEqual([u16(1).asUint64(), u16(2).asUint64()])
    })

    it('assigns incrementing account ids to distinct accounts', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceApp = ctx.any.application()
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, instanceApp)
      ctx.defaultSender = instanceApp.address

      const first = contract.getOrCreateAccountWithInstance(ctx.any.account(), instanceNum)
      const second = contract.getOrCreateAccountWithInstance(ctx.any.account(), instanceNum)

      expect(first.accountId.asUint64()).toEqual(u32(1).asUint64())
      expect(second.accountId.asUint64()).toEqual(u32(2).asUint64())
    })

    it('allows the registry admin to register an account', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceApp = ctx.any.application()
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, instanceApp)

      // admin defaults to the creator; sender stays the creator (not the instance app)
      const actual = contract.getOrCreateAccountWithInstance(ctx.any.account(), instanceNum)

      expect(actual.accountId.asUint64()).toEqual(u32(1).asUint64())
      expect(instanceIds(actual)).toEqual([u16(1).asUint64()])
    })

    it('rejects when the caller is neither the instance app nor the admin', () => {
      const contract = ctx.contract.create(FracDelegationRegistryContractTest)
      const instanceApp = ctx.any.application()
      const instanceNum = u16(1)
      seedInstance(contract, instanceNum, instanceApp)

      ctx.defaultSender = ctx.any.account() // neither the instance app nor the admin (creator)

      expectArc65Error(
        ctx,
        () => contract.getOrCreateAccountWithInstance(ctx.any.account(), instanceNum),
        errUnauthorized,
      )
    })
  })
})
