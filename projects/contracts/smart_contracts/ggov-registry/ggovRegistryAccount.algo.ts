import { Account, BoxMap, clone, err, GlobalState, log, uint64 } from '@algorandfoundation/algorand-typescript'
import { abimethod, encodeArc4, Uint16, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { BaseContract } from '../base/base.algo'
import {
  errAccountExists,
  errAccountNotExists,
  errAccountOffsetExists,
  errAccountOffsetNotExists,
} from '../base/errors.algo'
import { GGovAccount } from '../base/types.algo'
import { ensure, u32 } from '../base/utils.algo'

export class GGovRegistryAccountContract extends BaseContract {
  /** Last account numeric ID */
  lastAccountId = GlobalState<uint64>({ initialValue: 0 })
  /** gGov accounts box map */
  accounts = BoxMap<Account, GGovAccount>({ keyPrefix: 'a' })

  /**
   * Create new account ID
   * @param account Account to create ID for
   * @throws ERR:AUTH if account already has ID
   * @returns new account ID
   */
  protected createAccount(account: Account): GGovAccount {
    const box = this.accounts(account)
    ensure(!box.exists, errAccountExists)
    this.lastAccountId.value++
    const accountId = u32(this.lastAccountId.value)
    box.value = this.getEmptyGGovAccount(accountId)
    return box.value
  }

  /**
   * Get account ID if exists, else return 0
   * @param account Account to get ID for
   * @returns Account ID or 0 if not exists
   */
  protected getAccountIfExists(account: Account): GGovAccount {
    const box = this.accounts(account)
    if (box.exists) return box.value
    else return this.getEmptyGGovAccount(u32(0))
  }

  /** Get empty gGov account struct with `accountId` */
  protected getEmptyGGovAccount(accountId: Uint32): GGovAccount {
    return { accountId: accountId, committeeOffsets: [] }
  }

  /**
   * Get account ID or fail
   * @param account Account to get ID for
   * @throws ERR:A_NX if account does not exist
   * @returns Account ID
   */
  protected mustGetAccount(account: Account): GGovAccount {
    const accountBox = this.accounts(account)
    ensure(accountBox.exists, errAccountNotExists)
    return accountBox.value
  }

  /**
   * Get validated account or create account
   * @param account Account to get or create ID for
   * @returns account ID
   */
  protected getOrCreateAccount(account: Account): GGovAccount {
    const gGovAccount = this.getAccountIfExists(account)
    if (gGovAccount.accountId.asUint64() === 0) {
      return this.createAccount(account)
    } else {
      return gGovAccount
    }
  }

  protected getCommitteeAccountOffsetHint(committeeNumId: Uint16, gGovAccount: GGovAccount): uint64 {
    for (const [cNumId, offset] of clone(gGovAccount.committeeOffsets)) {
      if (cNumId.asUint64() === committeeNumId.asUint64()) {
        return offset.asUint64()
      }
    }
    // would like to use an arc65 fail() here ideally but this is also ok I guess. see utils.algo.ts
    log(errAccountOffsetNotExists)
    err()
  }

  protected addCommitteeAccountOffsetHint(
    committeeNumId: Uint16,
    account: Account,
    gGovAccount: GGovAccount,
    offset: Uint16,
  ): void {
    for (const [cNumId, _] of clone(gGovAccount.committeeOffsets)) {
      ensure(cNumId.asUint64() !== committeeNumId.asUint64(), errAccountOffsetExists)
    }
    gGovAccount.committeeOffsets.push([committeeNumId, offset])
    this.accounts(account).value = clone(gGovAccount)
  }

  protected removeCommitteeAccountOffsetHint(committeeNumId: Uint16, account: Account, gGovAccount: GGovAccount): void {
    let found = false
    const nextOffsets: [Uint16, Uint16][] = []
    for (let i: uint64 = 0; i < gGovAccount.committeeOffsets.length; i++) {
      const [cNumId, existingOffset] = gGovAccount.committeeOffsets[i]
      if (cNumId.asUint64() === committeeNumId.asUint64()) {
        found = true
      } else {
        nextOffsets.push([cNumId, existingOffset])
      }
    }
    ensure(found, errAccountOffsetNotExists)
    this.accounts(account).value = {
      accountId: gGovAccount.accountId,
      committeeOffsets: clone(nextOffsets),
    }
  }

  /**
   * Get account ID if exists, else return 0
   * @param account account to look up
   * @returns account ID or 0 if not found
   */
  @abimethod({ readonly: true })
  public getAccount(account: Account): GGovAccount {
    return this.getAccountIfExists(account)
  }

  /**
   * Log multiple accounts' IDs (or zero if not found)
   * Used to fetch account>ID quickly off-chain
   * @param accounts accounts to log
   */
  @abimethod({ readonly: true })
  public logAccounts(accounts: Account[]): void {
    for (const account of accounts) {
      log(encodeArc4(this.getAccountIfExists(account)))
    }
  }
}
