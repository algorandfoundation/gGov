import { AccountWithAlgoHours } from '../types'

export function accountWithAlgoHoursToTuple(accountWithAlgoHours: AccountWithAlgoHours): [string, bigint] {
  return [accountWithAlgoHours.account.toString(), accountWithAlgoHours.algoHours]
}
