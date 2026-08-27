/** Opcode cost of an `increaseBudget` call, and of each inner txn it submits. */
// sync with "increaseBudget opcode cost" tests in contracts/smart_contracts/base/base.e2e.spec.ts
export const increaseBudgetBaseCost = 23
export const increaseBudgetIncrementCost = 21

/** Algorand atomic group transaction limit. */
export const MAX_GROUP_SIZE = 16
