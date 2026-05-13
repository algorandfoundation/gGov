import { AccountWithVotes } from "../types";

export function xGovToTuple(xGov: AccountWithVotes): [string, number] {
  return [
    xGov.account.toString(),
    xGov.votes,
  ];
}
