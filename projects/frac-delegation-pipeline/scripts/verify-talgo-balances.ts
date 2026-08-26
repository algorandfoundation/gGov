/**
 * Verify the tALGO/stALGO transfer replay against live chain state.
 *
 * Replays from the newest committed snapshot under `snapshots/talgo/` to the Indexer's current
 * round and diffs every holder's balance against the asset balances the Indexer reports. Exits
 * non-zero on any difference: the snapshot chain and the chain disagree, and every AlgoQuarters
 * figure derived from it is suspect.
 *
 * Replaces the retired `pnpm --filter ggov-algoquarters verify:tinyman`, along with the package.
 *
 * USAGE
 *   pnpm verify-talgo-balances
 *
 * Reads mainnet only — writes nothing, on chain or on disk.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { TalgoPipelinePlugin } from '../src/plugins/talgo/index.ts'

const plugin = new TalgoPipelinePlugin(AlgorandClient.fromEnvironment())
await plugin.init()

await plugin.verifyAgainstChain().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
