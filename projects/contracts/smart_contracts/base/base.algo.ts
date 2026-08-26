import {
  compile,
  Contract,
  Global,
  itxn,
  loggedAssert,
  OnCompleteAction,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { abimethod } from '@algorandfoundation/algorand-typescript/arc4'
import { errUnauthorized } from './errors.algo'

export class EmptyContract extends Contract {}

export abstract class BaseContract extends Contract {
  /**
   * Ensures the caller is the contract creator (admin)
   * @throws ERR:AUTH if caller is not admin
   */
  protected ensureCallerIsAdmin(): void {
    loggedAssert(Txn.sender === Global.creatorAddress, errUnauthorized)
  }

  /**
   * Utility to increase opcode budget by performing $itxns no-op itxns
   * @param itxns Number of no-op itxns to perform
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public increaseBudget(itxns: uint64) {
    const empty = compile(EmptyContract)
    for (let i: uint64 = 0; i < itxns; i++) {
      itxn
        .applicationCall({
          approvalProgram: empty.clearStateProgram, // intentionally using clear state program for "return true"
          clearStateProgram: empty.clearStateProgram,
          onCompletion: OnCompleteAction.DeleteApplication,
        })
        .submit()
    }
  }
}
