import type { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { expect } from 'vitest'

export function expectArc65Error(ctx: TestExecutionContext, fn: () => void, errCode: string) {
  try {
    fn()
    throw new Error('Expected function to throw an error, but it did not.')
  } catch (error) {
    const { appLogs } = ctx.txn.activeGroup.transactions[0] as any
    if (!appLogs || appLogs.length === 0) {
      throw new Error('No application logs found in the transaction.', { cause: error })
    }
    const lastLogStr = Buffer.from(appLogs[appLogs.length - 1].bytes, 'hex').toString('utf8')
    expect(lastLogStr).toBe(errCode)
  }
}
