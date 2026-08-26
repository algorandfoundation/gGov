/**
 * Regression check for the migrated reti AlgoQuarters engine.
 *
 * Recomputes a window the retired `algoquarters:reti` CLI already produced through
 * `RetiPipelinePlugin.calculateWholeProtocolAQ` — the unsliced, protocol-wide path — and diffs the
 * result against the archived manifest in `data/reti/`. Every account has to match exactly.
 *
 * That exactness is the point: the engine now accrues per (pool, staker) instead of per staker, so
 * a committee's instances can each be credited for their own pools. Accrual is linear, so summing
 * every pool's unfloored microALGO-rounds and flooring once has to reproduce the old
 * aggregate-then-floor numbers to the AlgoQuarter. Any difference means the replay itself moved.
 *
 * It also exercises the snapshot chain: the boundary snapshots inside the window are committed, so
 * the verify-first chaining re-derives and compares them rather than writing anything.
 *
 * USAGE
 *   pnpm verify-reti-aq                        # defaults to the newest archived window
 *   pnpm verify-reti-aq 59000000 62000000
 *
 * Reads mainnet only — writes nothing on chain, and touches no contracts.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { AlgoQuartersData } from '../src/aq/index.ts'
import { RetiPipelinePlugin } from '../src/plugins/reti/index.ts'

const ARCHIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'reti')

function resolveWindow(args: string[]): { periodStart: number; periodEnd: number } {
  if (args.length === 2) return { periodStart: Number(args[0]), periodEnd: Number(args[1]) }
  if (args.length !== 0) throw new Error('Usage: pnpm verify-reti-aq [<periodStart> <periodEnd>]')
  const windows = readdirSync(ARCHIVE_DIR)
    .flatMap((name) => {
      const match = /^(\d+)-(\d+)\.json$/.exec(name)
      return match ? [{ periodStart: Number(match[1]), periodEnd: Number(match[2]) }] : []
    })
    .sort((a, b) => a.periodStart - b.periodStart)
  if (!windows.length) throw new Error(`No archived manifests in ${ARCHIVE_DIR}`)
  return windows[windows.length - 1]
}

async function main() {
  const { periodStart, periodEnd } = resolveWindow(process.argv.slice(2))
  const expected = JSON.parse(
    readFileSync(join(ARCHIVE_DIR, `${periodStart}-${periodEnd}.json`), 'utf-8'),
  ) as AlgoQuartersData

  console.log(`\nRecomputing reti AQ for rounds [${periodStart}, ${periodEnd}) — whole protocol, every pool`)
  console.log(`Expecting ${expected.totalAccounts} accounts, ${expected.totalAlgoQuarters} AQ\n`)

  const plugin = new RetiPipelinePlugin(AlgorandClient.fromEnvironment())
  await plugin.init()
  const { protocol, accounts } = await plugin.calculateWholeProtocolAQ(periodStart, periodEnd)

  const problems: string[] = []
  const check = (label: string, actual: unknown, want: unknown) => {
    if (actual !== want) problems.push(`${label}: got ${String(actual)}, expected ${String(want)}`)
  }
  check('protocol', protocol, expected.protocol)
  check('totalAccounts', Object.keys(accounts).length, expected.totalAccounts)

  const total = Object.values(accounts).reduce((sum, aq) => sum + BigInt(aq), 0n)
  check('totalAlgoQuarters', total.toString(), expected.totalAlgoQuarters)

  const remaining = new Map(Object.entries(accounts))
  for (const { account, algoQuarters } of expected.accounts) {
    const actual = remaining.get(account)
    if (actual === undefined) problems.push(`missing account ${account} (expected ${algoQuarters} AQ)`)
    else if (actual.toString() !== algoQuarters) problems.push(`${account}: got ${actual} AQ, expected ${algoQuarters}`)
    remaining.delete(account)
  }
  for (const [account, aq] of remaining) problems.push(`unexpected account ${account} with ${aq} AQ`)

  if (problems.length) {
    // Cap the dump: a systematic difference produces one line per account
    const shown = problems.slice(0, 20)
    throw new Error(
      `${problems.length} difference(s) from the archived manifest:\n${shown.join('\n')}` +
        (problems.length > shown.length ? `\n… and ${problems.length - shown.length} more` : ''),
    )
  }

  console.log(`\n✓ Exact match: ${expected.totalAccounts} accounts, ${expected.totalAlgoQuarters} AQ`)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
