// sync with "increaseBudget opcode cost" tests in contracts/smart_contracts/base/base.e2e.spec.ts
export const increaseBudgetBaseCost = 23
export const increaseBudgetIncrementCost = 23

/** Algorand atomic group transaction limit. */
export const MAX_GROUP_SIZE = 16

/** Body chunk size (bytes) for partial-upload txns (period approval, period/topic bodies). */
export const BODY_CHUNK_BYTES = 2000

/**
 * Max serialized size (bytes) of a period/topic body the SDK will upload — the body box must fit in a
 * single {@link MAX_GROUP_SIZE}-transaction upload group. A body box is a plain AVM box (hard cap
 * 32_768 bytes), but the binding limit is lower: writing a box of size S requires ~S/1024 box
 * references in the group, and each txn holds at most 8 — so a box needs ~S/8192 app calls to upload.
 * Spilling chunks into a second, smaller group fails ("No more transactions below reference limit")
 * because that group operates on the already-full box with too few app calls to cover its I/O budget.
 * Keeping every body to one full group sidesteps that: {@link MAX_GROUP_SIZE} chunks of
 * {@link BODY_CHUNK_BYTES} = 32_000 bytes, comfortably under the 32_768 box cap.
 */
export const MAX_BODY_BYTES = MAX_GROUP_SIZE * BODY_CHUNK_BYTES

// ── MBRs ──────────────────────────----------------------------------

/**
 * Default MBR (µAlgo) sent from operator to registry per createPeriod call.
 * Covers the spawned period app's account MBR: 100k base + 7*28.5k global ints +
 * 3*50k global bytes + 3*100k extra pages ≈ 750k. 1 ALGO buys a healthy buffer
 * and keeps the math stable if the period schema grows into its reserved slots.
 */
export const DEFAULT_PERIOD_MBR_MICROALGOS = 1_000_000n

/**
 * Box MBR (µAlgo) the registry app account pays for a delegation whose delegatee has no delegators
 * yet: the delegator's `delegations` box (28_500) plus a fresh `reverseDelegations` box for the
 * delegatee (29_300).
 *
 * Charged on every delegation path — `setVotingAccount`, `mirrorXGovDelegation` and
 * `importFracDelegation` alike — and none of them carries a payment, so the registry pays out of
 * its own balance. Keep it funded ahead of a large import or the box writes fail the group.
 * Fully reclaimed when the delegation is cleared.
 */
export const DELEGATION_MBR_NEW_DELEGATEE_MICROALGOS = 57_800n

/**
 * Box MBR (µAlgo) for a delegation to a delegatee that already has delegators: the delegator's
 * `delegations` box (28_500) plus the growth of the delegatee's existing `reverseDelegations` box
 * by one address (12_800).
 */
export const DELEGATION_MBR_EXISTING_DELEGATEE_MICROALGOS = 41_300n

// ── Import Fractional Delegations ──────────────────────────---------

/**
 * Escrows per `importFracDelegation` call — bounded by the AVM's 1024-byte log budget, NOT by
 * references. Each escrow emits one 100-byte ARC-28 `GGovDelegationSet`, and the budget is per app
 * call, so padding cannot buy more of it: `floor(1024 / 100)` = 10.
 */
export const MAX_ESCROWS_PER_FD_IMPORT = 10
