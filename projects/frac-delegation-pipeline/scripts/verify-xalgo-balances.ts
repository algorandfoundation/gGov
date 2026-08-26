/**
 * Verify the xALGO/fxALGO transfer replay and the escrow resolution against live chain state.
 *
 * Replays from the newest committed snapshot under `snapshots/xalgo/` to the Indexer's current
 * round and diffs every holder's balance against the asset balances the Indexer reports; then
 * cross-checks `snapshots/xalgo/beneficiaries.json` against the live local state of every current
 * fxALGO holder. Exits non-zero on any difference: the snapshot chain and the chain disagree, and
 * every AlgoQuarters figure derived from it is suspect.
 *
 * USAGE
 *   pnpm verify-xalgo-balances
 *
 * Reads mainnet only — writes nothing, on chain or on disk.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { XalgoPipelinePlugin } from '../src/plugins/xalgo/index.ts'

const plugin = new XalgoPipelinePlugin(AlgorandClient.fromEnvironment())
await plugin.init()

await plugin.verifyAgainstChain().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
