// Number of rounds per scan window — constrains min/max-round to prevent indexer SQL timeouts.
// 1M rounds ≈ 1 month.
export const SCAN_WINDOW = 1_000_000n

// Snapshots are saved at multiples of this interval
export const SNAPSHOT_INTERVAL = 1_000_000n
// Sanity cap on an algoquarters window: committee windows are ~3M rounds; anything bigger is almost surely a typo
export const MAX_WINDOW = 10n * SNAPSHOT_INTERVAL
