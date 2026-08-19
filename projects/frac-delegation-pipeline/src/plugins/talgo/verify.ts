/**
 * Verify the transfer replay against live chain state.
 *
 * Replays tALGO/stALGO transfers from the latest committed snapshot up to the Indexer's current
 * round, then diffs every holder's balance against the asset balances the Indexer reported.
 * Throws on any difference: the replay and the chain disagree, and every AlgoQuarters figure
 * derived from that snapshot chain is suspect.
 *
 * Reached through `TalgoPipelinePlugin.verifyAgainstChain()`.
 */

import { type Indexer } from 'algosdk'

import { INDEXER_PAGE_SIZE, scanAssetTransfers, withRetry } from 'ggov-algoquarters'
import { STALGO_ASA_ID, TALGO_ASA_ID } from './constants.ts'
import { applyTransfer } from './ledger.ts'
import { diffBalances, getAllSnapshotBalances, type TalgoSnapshotStore } from './snapshot.ts'
import type { BalanceMap } from './types.ts'

/** Page every positive holding of `assetId`; retries if the Indexer advances mid-pagination. */
async function fetchLiveHoldings(
  indexer: Indexer,
  assetId: bigint,
  label: string,
): Promise<{ holdings: Map<string, bigint>; round: bigint }> {
  for (let attempt = 1; ; attempt++) {
    const holdings = new Map<string, bigint>()
    let round: bigint | undefined
    let nextToken: string | undefined

    do {
      let request = indexer.lookupAssetBalances(assetId).currencyGreaterThan(0).limit(INDEXER_PAGE_SIZE)
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

/**
 * Replay from the newest committed snapshot to the current round and diff against live holdings.
 * @throws if any holder's replayed balance differs from the chain's
 */
export async function verifyAgainstChain(indexer: Indexer, store: TalgoSnapshotStore): Promise<void> {
  const baseRound = store.latestSnapshotRound()
  console.log(`\nVerifying tALGO replay against live chain state (base snapshot: ${baseRound})\n`)

  console.log('Fetching live asset balances…')
  const [talgo, stalgo] = await Promise.all([
    fetchLiveHoldings(indexer, TALGO_ASA_ID, 'tALGO'),
    fetchLiveHoldings(indexer, STALGO_ASA_ID, 'stALGO'),
  ])

  // The two balance fields are independent, so each asset is replayed to the round its
  // holder set was served at — no cross-asset synchronization needed.
  console.log(`\nReplaying transfers…`)
  const balances = getAllSnapshotBalances(store.readSnapshot(baseRound))
  await scanAssetTransfers(indexer, TALGO_ASA_ID, baseRound, talgo.round + 1n, (batch) => {
    for (const transfer of batch) applyTransfer(balances, transfer, 'talgo')
  })
  await scanAssetTransfers(indexer, STALGO_ASA_ID, baseRound, stalgo.round + 1n, (batch) => {
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
