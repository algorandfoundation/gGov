import { AccountWithVotes } from './types.js'

export function govToTuple(gov: AccountWithVotes): [string, number] {
  return [gov.account.toString(), gov.votes]
}
