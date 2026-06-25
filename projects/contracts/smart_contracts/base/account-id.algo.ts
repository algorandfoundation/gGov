import { Account, BoxMap, GlobalState, uint64 } from '@algorandfoundation/algorand-typescript'
import { Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from './base.algo'
import { errAccountExists, errAccountNotExists } from './errors.algo'
import { ensure, u32 } from './utils.algo'

// Not used in gGov - we need more complex/specific value schema
// Instead we use ggovRegistryAccount that mirrors this

export abstract class AccountIdContract extends BaseContract {
  lastAccountId = GlobalState<uint64>({ initialValue: 0 })
  accountIds = BoxMap<Account, Uint32>({ keyPrefix: 'a' })

  /**
   * Create new account ID
   * @param account Account to create ID for
   * @throws ERR:A_EX if account already has ID
   * @returns new account ID
   */
  protected createAccountId(account: Account): Uint32 {
    const box = this.accountIds(account)
    ensure(!box.exists, errAccountExists)
    this.lastAccountId.value++
    const accountId = u32(this.lastAccountId.value)
    box.value = accountId
    return accountId
  }

  /**
   * Get account ID if exists, else return 0
   * @param account Account to get ID for
   * @returns Account ID or 0 if not exists
   */
  protected getAccountIdIfExists(account: Account): Uint32 {
    const box = this.accountIds(account)
    if (box.exists) return box.value
    else return u32(0)
  }

  /**
   * Get account ID or fail
   * @param account Account to get ID for
   * @throws ERR:A_NX if account does not exist
   * @returns Account ID
   */
  protected mustGetAccountId(account: Account): Uint32 {
    const accountIdBox = this.accountIds(account)
    ensure(accountIdBox.exists, errAccountNotExists)
    return accountIdBox.value
  }

  /**
   * Get validated account ID or create account ID
   * @param account Account to get or create ID for
   * @returns account ID
   */
  protected getOrCreateAccountId(account: Account): Uint32 {
    const accountId = this.getAccountIdIfExists(account)
    if (accountId.asUint64() === 0) {
      return this.createAccountId(account)
    } else {
      return accountId
    }
  }
}
