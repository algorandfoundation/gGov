/**
 * Shared AlgoQuarters primitives: the Indexer scans, the snapshot chaining, and the AQ unit.
 *
 * Source-specific pipelines build on these. The tALGO pipeline lives in the frac delegation
 * pipeline's `talgo` plugin (`projects/frac-delegation-pipeline/src/plugins/talgo`); reti still
 * runs from the CLIs under `src/reti`, and moves the same way when it is wired into the pipeline.
 */

export {
  INDEXER_PAGE_SIZE,
  fetchAssetMetadata,
  fetchGenesisHash,
  getAppEventsFromTransaction,
  scanAssetTransfers,
  scanTransactionRecords,
  withRetry,
} from './indexer.ts'

export { MAX_WINDOW, SCAN_WINDOW, SNAPSHOT_INTERVAL, createIndexerClient } from './config.ts'

export { checkOrCreateSnapshots, createSnapshotFiles, type SnapshotStore } from './snapshots.ts'

export { MICROALGO_ROUNDS_PER_AQ, assertAlgoQuartersFitUint32 } from './utils/aq.ts'
export { stringifyJson } from './utils/json.ts'
export { openTransferLog } from './utils/transfer-log.ts'

export type { AccountWithAlgoQuarters, AlgoQuartersData, AssetTransfer } from './types.ts'
