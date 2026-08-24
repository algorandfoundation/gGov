// Number of rounds per scan window — constrains min/max-round to prevent indexer SQL timeouts.
// 1M rounds ≈ 1 month.
export const SCAN_WINDOW = 1_000_000n

// How many scan windows are fetched at once. Windows cover disjoint round ranges, so they are
// independent requests; only their delivery has to stay ordered.
//
// This is the *default*: the pipeline passes its own `concurrency` down into the plugins, so a run
// configured for a rate-limited indexer overrides it, and this value is what a plugin built
// standalone (a script, a test) gets.
//
// It multiplies with the concurrency above it, so mind the total: stage 3 runs the sources
// concurrently, and tALGO and xALGO each scan two assets at once, so a full run can have
// (reti 1 + tALGO 2 + xALGO 2) x this many requests in flight. `withRetry` backs off on 429s, but
// not overrunning beats retrying — turn the pipeline's `concurrency` down before the others.
export const SCAN_CONCURRENCY = 4

// Snapshots are saved at multiples of this interval
export const SNAPSHOT_INTERVAL = 1_000_000n
// Sanity cap on an algoquarters window: committee windows are ~3M rounds; anything bigger is almost surely a typo
export const MAX_WINDOW = 10n * SNAPSHOT_INTERVAL
