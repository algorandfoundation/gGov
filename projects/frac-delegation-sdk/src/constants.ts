/** Partial verbatim copy of ggov-sdk/src/constants.ts */
export const increaseBudgetBaseCost = 23
export const increaseBudgetIncrementCost = 23

/** Algorand atomic group transaction limit. */
export const MAX_GROUP_SIZE = 16

/**
 * Foreign/box reference slots per app call txn — algokit's `MAX_APP_CALL_FOREIGN_REFERENCES`.
 * Slots are pooled across the group, so a group carries 8 x (number of app calls).
 */
export const REF_SLOTS_PER_APP_CALL = 8

/** Body chunk size (bytes) for partial-upload txns (instance approval bytecode). */
export const BODY_CHUNK_BYTES = 2000

/**
 * Default MBR (µAlgo) sent from admin to registry per createInstance call.
 * Covers the spawned instance app's account MBR: 100k base + X*28.5k global ints +
 * Y*50k global bytes + Z*100k extra pages ≈ ????. 1 ALGO buys a healthy buffer
 * and keeps the math stable if the instance schema grows into its reserved slots.
 */
// TODO: complete X, Y, Z and the final MBR estimation when  contract is finished
export const DEFAULT_INSTANCE_MBR_MICROALGOS = 1_000_000n
