/**
 * Verify the reti event replay against live chain state.
 *
 * Replays ValidatorRegistry events from the newest committed snapshot under `snapshots/reti/` to
 * the Indexer's current round, then compares every pool's stakers — balance and entry round —
 * against its live `stakers` box, plus the registry's own protocol-wide `staked` total. Exits
 * non-zero on any difference: the snapshot chain and the chain disagree, and every AlgoQuarters
 * figure derived from it is suspect.
 *
 * Replaces the retired `pnpm --filter ggov-algoquarters verify:reti`.
 *
 * USAGE
 *   pnpm verify-reti-balances
 *
 * Reads mainnet only — writes nothing, on chain or on disk.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { RetiPipelinePlugin } from '../src/plugins/reti/index.ts'

const plugin = new RetiPipelinePlugin(AlgorandClient.fromEnvironment())
await plugin.init()

await plugin.verifyAgainstChain().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
