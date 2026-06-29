import { AccountWithVotes } from './types'

export function govToTuple(gov: AccountWithVotes): [string, number] {
  return [gov.account.toString(), gov.votes]
}
