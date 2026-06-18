// sync with "increaseBudget opcode cost" registry tests
export const increaseBudgetBaseCost = 23
export const increaseBudgetIncrementCost = 23

/** Algorand atomic group transaction limit. */
export const MAX_GROUP_SIZE = 16

/** Body chunk size (bytes) for partial-upload txns (period approval, period/topic bodies). */
export const BODY_CHUNK_BYTES = 2000

/**
 * Default MBR (µAlgo) sent from operator to registry per createPeriod call.
 * Covers the spawned period app's account MBR: 100k base + 7*28.5k global ints +
 * 3*50k global bytes + 3*100k extra pages ≈ 750k. 1 ALGO buys a healthy buffer
 * and keeps the math stable if the period schema grows into its reserved slots.
 */
export const DEFAULT_PERIOD_MBR_MICROALGOS = 1_000_000n
