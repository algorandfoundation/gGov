/**
 * Verify the transfer replay against live chain state.
 *
 * Replays tALGO/stALGO transfers from the latest committed snapshot up to the Indexer's
 * current round, then diffs every holder's balance against the asset balances the Indexer
 * reported. Exits non-zero on any difference: the replay and the chain disagree.
 *
 * Usage:
 *   pnpm verify:tinyman
 *
 * Env:
 *   INDEXER_SERVER   indexer base URL (default: public Nodely mainnet indexer)
 *   INDEXER_TOKEN    API token if required
 */

import { INDEXER_PAGE_SIZE, indexerClient, scanAssetTransfers, withRetry } from '../indexer'
import { STALGO_ASA_ID, TALGO_ASA_ID } from './constants'
import { applyTransfer } from './ledger'
import { diffBalances, getAllSnapshotBalances, latestSnapshotRound, readSnapshot } from './snapshot/operations'
import type { BalanceMap } from './types'

/** Page every positive holding of `assetId`; retries if the Indexer advances mid-pagination. */
async function fetchLiveHoldings(
  assetId: bigint,
  label: string,
): Promise<{ holdings: Map<string, bigint>; round: bigint }> {
  for (let attempt = 1; ; attempt++) {
    const holdings = new Map<string, bigint>()
    let round: bigint | undefined
    let nextToken: string | undefined

    do {
      let request = indexerClient.lookupAssetBalances(assetId).currencyGreaterThan(0).limit(INDEXER_PAGE_SIZE)
      if (nextToken) request = request.nextToken(nextToken)
      const data = await withRetry(() => request.do())

      round ??= data.currentRound
      if (data.currentRound !== round) {
        round = undefined
        break
      }
      for (const holding of data.balances ?? []) holdings.set(holding.address, holding.amount)
      nextToken = data.nextToken
      if (nextToken && (data.balances ?? []).length === 0) break
    } while (nextToken)

    if (round !== undefined) {
      console.log(`  [${label}] ${holdings.size} holders at round ${round}`)
      return { holdings, round }
    }
    if (attempt >= 3) throw new Error(`Could not page a consistent ${label} holder set: the Indexer keeps advancing`)
    console.log(`  [${label}] indexer advanced mid-pagination — retrying (${attempt}/3)`)
  }
}

async function main() {
  const baseRound = latestSnapshotRound()
  console.log(`\nVerifying tinyman replay against live chain state (base snapshot: ${baseRound})\n`)

  console.log('Fetching live asset balances…')
  const [talgo, stalgo] = await Promise.all([
    fetchLiveHoldings(TALGO_ASA_ID, 'tALGO'),
    fetchLiveHoldings(STALGO_ASA_ID, 'stALGO'),
  ])

  // The two balance fields are independent, so each asset is replayed to the round its
  // holder set was served at — no cross-asset synchronization needed.
  console.log(`\nReplaying transfers…`)
  const balances = getAllSnapshotBalances(readSnapshot(baseRound))
  await scanAssetTransfers(TALGO_ASA_ID, baseRound, talgo.round + 1n, (batch) => {
    for (const transfer of batch) applyTransfer(balances, transfer, 'talgo')
  })
  await scanAssetTransfers(STALGO_ASA_ID, baseRound, stalgo.round + 1n, (batch) => {
    for (const transfer of batch) applyTransfer(balances, transfer, 'stalgo')
  })

  const liveBalances: BalanceMap = new Map()
  for (const [address, amount] of talgo.holdings) liveBalances.set(address, { talgo: amount, stalgo: 0n })
  for (const [address, amount] of stalgo.holdings) {
    const entry = liveBalances.get(address) ?? { talgo: 0n, stalgo: 0n }
    entry.stalgo = amount
    liveBalances.set(address, entry)
  }
  const diffs = diffBalances(balances, liveBalances)
  if (diffs.length > 0) {
    throw new Error(`${diffs.length} holder(s) differ from the chain:\n${diffs.join('\n')}`)
  }
  console.log(
    `\n✓ Replay matches the chain: every holder's balance is exact ` +
      `(tALGO at round ${talgo.round}, stALGO at round ${stalgo.round})`,
  )
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
