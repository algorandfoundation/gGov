/**
 * Shared AlgoQuarters primitives: the Indexer scans, the snapshot chaining, and the AQ unit.
 *
 * Every source's engine builds on these, as a plugin under `../plugins`.
 */

export {
  INDEXER_PAGE_SIZE,
  fetchAssetMetadata,
  getAppEventsFromTransaction,
  scanAssetTransfers,
  scanTransactionRecords,
  withRetry,
} from './indexer.ts'

export { MAX_WINDOW, SCAN_WINDOW, SNAPSHOT_INTERVAL } from './config.ts'

export { checkOrCreateSnapshots, createSnapshotFiles, type SnapshotStore } from './snapshots.ts'

export { MICROALGO_ROUNDS_PER_AQ, assertAlgoQuartersFitUint32 } from './utils/aq.ts'
export { stringifyJson } from './utils/json.ts'

export type { AccountWithAlgoQuarters, AlgoQuartersData, AssetTransfer } from './types.ts'
