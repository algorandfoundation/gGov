/**
 * Dry run of the xALGO AlgoQuarters calculation over one window — the way to cold-build the first
 * snapshot and the beneficiary cache outside a pipeline run, and to eyeball a window's result before
 * it is ever ingested.
 *
 * Computes through `XalgoPipelinePlugin.calculateCommitteeAQ` exactly as the pipeline does, so the
 * boundary snapshots inside the window and every newly resolved escrow owner ARE written to
 * `snapshots/xalgo/` (verify-first: an existing snapshot that disagrees aborts the run). Nothing is
 * ingested: no contract is touched.
 *
 * USAGE
 *   pnpm xalgo-aq 60000000 63000000
 *
 * Reads mainnet (the ALGOD and INDEXER variables from the environment).
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { XALGO_INSTANCE_NAME, XalgoPipelinePlugin } from '../src/plugins/xalgo/index.ts'

const TOP_N = 10

function resolveWindow(args: string[]): { periodStart: number; periodEnd: number } {
  if (args.length !== 2) throw new Error('Usage: pnpm xalgo-aq <periodStart> <periodEnd>')
  const periodStart = Number(args[0])
  const periodEnd = Number(args[1])
  if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd)) throw new Error('rounds must be integers')
  return { periodStart, periodEnd }
}

async function main() {
  const { periodStart, periodEnd } = resolveWindow(process.argv.slice(2))
  console.log(`\nComputing xALGO AQ for rounds [${periodStart}, ${periodEnd})\n`)

  const plugin = new XalgoPipelinePlugin(AlgorandClient.fromEnvironment())
  await plugin.init()
  const started = Date.now()
  // No instances: xALGO ignores them, being a single instance, and answers with the one entry
  const calculated = await plugin.calculateCommitteeAQ({ numericId: 0, periodStart, periodEnd }, [])
  const calculation = calculated.get(XALGO_INSTANCE_NAME)
  if (!calculation) throw new Error(`Plugin returned no calculation for ${XALGO_INSTANCE_NAME}`)
  const { protocol, rate, accounts } = calculation

  const entries = Object.entries(accounts).sort(([, a], [, b]) => b - a)
  const total = entries.reduce((sum, [, aq]) => sum + aq, 0)
  console.log(
    `\n${protocol}: ${entries.length} accounts, ${total.toLocaleString()} AQ at rate ${rate} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
  )
  console.log(`\nTop ${TOP_N} accounts:`)
  for (const [account, aq] of entries.slice(0, TOP_N)) {
    console.log(`  ${account}  ${aq.toLocaleString()} (${((100 * aq) / total).toFixed(2)}%)`)
  }
}

await main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
