// Number of rounds per scan window — constrains min/max-round to prevent indexer SQL timeouts.
// 1M rounds ≈ 1 month.
export const SCAN_WINDOW = 1_000_000n

// How many scan windows are fetched at once. Windows cover disjoint round ranges, so they are
// independent requests; only their delivery has to stay ordered.
//
// This multiplies with the concurrency above it, so mind the total against a rate-limited indexer:
// stage 3 runs the sources concurrently, and tALGO and xALGO each scan two assets at once, so a
// full run can have (reti 1 + tALGO 2 + xALGO 2) x SCAN_CONCURRENCY requests in flight. `withRetry`
// backs off on 429s, but not overrunning beats retrying — turn this down before the others.
export const SCAN_CONCURRENCY = 4

// Snapshots are saved at multiples of this interval
export const SNAPSHOT_INTERVAL = 1_000_000n
// Sanity cap on an algoquarters window: committee windows are ~3M rounds; anything bigger is almost surely a typo
export const MAX_WINDOW = 10n * SNAPSHOT_INTERVAL
