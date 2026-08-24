/**
 * AlgoQuarter (AQ) conversion: 1 AQ = 1 ALGO staked for 3,000,000 rounds.
 * Accrual is exact microALGO·rounds, floored once per account to integer AQ
 * at storage time.
 */

/**
 * How many microALGO·rounds are one AQ.
 * 1 AQ = 1 ALGO × 3M rounds = 1e6 microALGO × 3e6 rounds = 3e12 microALGO·rounds.
 */
export const MICROALGO_ROUNDS_PER_AQ = 3_000_000_000_000n

/** Ceiling of AQ per account in the smart contract's storage schema. */
const UINT32_MAX = 4_294_967_295n

/** Assert an account's AQ value fits the uint32 stored on-chain. */
export function assertAlgoQuartersFitUint32(algoQuarters: bigint, account: string): void {
  if (algoQuarters > UINT32_MAX) {
    throw new Error(`AQ value for ${account} overflows uint32: ${algoQuarters}`)
  }
}
