/** Partial verbatim copy of ggov-sdk/src/constants.ts */
export const increaseBudgetBaseCost = 23
export const increaseBudgetIncrementCost = 23

/** Algorand atomic group transaction limit. */
export const MAX_GROUP_SIZE = 16

/** Body chunk size (bytes) for partial-upload txns (instance approval bytecode). */
export const BODY_CHUNK_BYTES = 2000

/**
 * Accounts per `ingestAq` call.
 *
 * The hard ceiling is the 2048-byte app-arg cap, not references: one entry encodes to 36 bytes
 * (32-byte address + uint32), so `4 selector + 2 committeeNumId + 2 array length + 36N <= 2048`
 * permits 56. Held well below that because references are what shape the group: N accounts need
 * `2N + 3` reference slots (see `makeIngestAqTxns`), and at 40 that is 83 slots = 11 app calls,
 * leaving room for the opcode-budget `increaseBudget` txn on top without passing the 16-txn limit.
 */
export const MAX_ACCOUNTS_PER_INGEST_AQ = 40

/**
 * Accounts per `uningestAq` call.
 *
 * Same cost profile as ingest: `uningestAq` takes addresses too and inner-calls the registry's
 * readonly `getAccount` once per account to resolve its ID, so N accounts need `2N + 2` reference
 * slots (registry `accounts` box + instance `accountAq` box per account, plus the registry app ref
 * and the `committeeAq` box; no registry `instances` box, unlike ingest). Held at 40 for parity with
 * {@link MAX_ACCOUNTS_PER_INGEST_AQ} and headroom under the 16-txn group limit; the arg cap
 * (`8 + 32N <= 2048`) and ref cap both allow ~63. Tunable up once confirmed by a localnet simulate.
 */
export const MAX_ACCOUNTS_PER_UNINGEST_AQ = 40

/**
 * Box MBR (µAlgo) the INSTANCE app account pays per ingested account: an `accountAq` box of
 * `2500 + 400 * (7-byte name + 4-byte value)`. Charged once per (account, committee).
 *
 * TODO? Calculate these vs real contracts with simulate?
 */
export const AQ_INSTANCE_MBR_PER_ACCOUNT_MICROALGOS = 6_900n

/**
 * Box MBR (µAlgo) the REGISTRY app account pays per account it has never seen: an `accounts` box of
 * `2500 + 400 * (33-byte name + ~10-byte value)`. Charged once per account across the whole frac
 * system, so a committee whose accounts are all already known costs nothing here.
 *
 * `ingestAq` has no funding path to the registry - top the registry app account up out of band
 * before a large ingest, or its box writes fail the group (and, before that, fail the simulate that
 * populates box references, which surfaces as an opaque resource error).
 *
 * TODO? Calculate these vs real contracts with simulate?
 */
export const AQ_REGISTRY_MBR_PER_NEW_ACCOUNT_MICROALGOS = 19_700n

/**
 * Default MBR (µAlgo) sent from admin to registry per createInstance call.
 * Covers the spawned instance app's account MBR: 100k base + X*28.5k global ints +
 * Y*50k global bytes + Z*100k extra pages ≈ ????. 1 ALGO buys a healthy buffer
 * and keeps the math stable if the instance schema grows into its reserved slots.
 */
// TODO: complete X, Y, Z and the final MBR estimation when  contract is finished
export const DEFAULT_INSTANCE_MBR_MICROALGOS = 1_000_000n
