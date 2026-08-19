/**
 * Verify the replay and the escrow resolution against live chain state.
 *
 * 1. Replays xALGO and fxALGO transfers from the latest committed snapshot up to the Indexer's
 *    current round and diffs every holder's balance against the asset balances the Indexer reports.
 * 2. Cross-checks the beneficiary cache against the chain: one paged
 *    `searchAccounts().assetID(fxALGO)` returns `authAddr` and live local state for every current
 *    fxALGO holder, so for each holder (pool excepted) the cached resolution — or, for a holder the
 *    cache has not met yet, a fresh one — has to agree with what the chain says now: a cached escrow
 *    must still name the same owner in the same app; a cached `self` must not be an open escrow of a
 *    tracked app. Plain holders that look like escrows of something else — several rekeyed to one
 *    address, or any rekeyed to another Folks loan app — are reported as warnings: that is how a
 *    Folks escrow type missing from `FOLKS_ESCROW_APPS` would show up.
 *
 * Throws on any difference or error: every AlgoQuarters figure derived from that snapshot chain is
 * suspect. Reached through `XalgoPipelinePlugin.verifyAgainstChain()`.
 */

import { type Indexer } from 'algosdk'

import { INDEXER_PAGE_SIZE, scanAssetTransfers, withRetry } from 'ggov-algoquarters'
import { escrowLikeWarnings, ownerFromLocalState, resolveBeneficiary, type SelfHolderCustody } from './beneficiaries.ts'
import {
  FOLKS_ESCROW_APPS,
  FOLKS_ESCROW_APP_BY_ID,
  FXALGO_ASA_ID,
  XALGO_ASA_ID,
  XALGO_POOL_ADDRESS,
} from './constants.ts'
import { applyTransfer } from './ledger.ts'
import { diffBalances, getAllSnapshotBalances, type XalgoSnapshotStore } from './snapshot.ts'
import type { BalanceMap, BeneficiaryMap } from './types.ts'

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
 * Cross-check the beneficiary cache against every current fxALGO holder's live state.
 * @throws listing every disagreement
 */
async function verifyBeneficiaries(indexer: Indexer, cache: BeneficiaryMap): Promise<void> {
  console.log('\nCross-checking escrow owners against live local state…')
  const errors: string[] = []
  const selfHolders: SelfHolderCustody[] = []
  const verifiedPerApp = new Map<string, number>(FOLKS_ESCROW_APPS.map((app) => [app.label, 0]))
  let holders = 0
  let cached = 0
  let fresh = 0
  let nextToken: string | undefined

  do {
    // only local state and auth-addr are read; excluding the rest keeps whales under the Indexer's
    // per-account resource cap ("Result limit exceeded")
    let request = indexer
      .searchAccounts()
      .assetID(FXALGO_ASA_ID)
      .currencyGreaterThan(0)
      .exclude('assets,created-assets,created-apps')
      .limit(INDEXER_PAGE_SIZE)
    if (nextToken) request = request.nextToken(nextToken)
    const data = await withRetry(() => request.do())

    for (const account of data.accounts ?? []) {
      const address = account.address
      if (address === XALGO_POOL_ADDRESS) continue
      holders++

      // what the chain says now: an open escrow of a tracked app names its owner in local state
      const localStates = account.appsLocalState ?? []
      const live = localStates.flatMap((state) => {
        const app = FOLKS_ESCROW_APP_BY_ID.get(state.id)
        const owner = app && ownerFromLocalState(state, app)
        return app && owner ? [{ app, owner }] : []
      })
      if (live.length > 1) {
        errors.push(
          `${address}: open escrow of ${live.length} tracked apps at once (${live.map((l) => l.app.label).join(', ')})`,
        )
        continue
      }

      let resolution = cache.get(address)
      if (resolution) cached++
      else {
        resolution = (await resolveBeneficiary(indexer, address)).beneficiary
        fresh++
      }

      if (resolution.kind === 'escrow') {
        const app = FOLKS_ESCROW_APP_BY_ID.get(BigInt(resolution.app))
        if (live.length === 0) {
          errors.push(
            `${address}: resolved as escrow of ${app?.label ?? resolution.app} (owner ${resolution.owner}) but has no open escrow local state`,
          )
        } else if (live[0].owner !== resolution.owner || Number(live[0].app.appId) !== resolution.app) {
          errors.push(
            `${address}: resolved as escrow of ${app?.label ?? resolution.app} owned by ${resolution.owner}, chain says ${live[0].app.label} owned by ${live[0].owner}`,
          )
        } else {
          verifiedPerApp.set(live[0].app.label, (verifiedPerApp.get(live[0].app.label) ?? 0) + 1)
        }
      } else if (live.length === 1) {
        errors.push(
          `${address}: resolved as a plain holder but is an open escrow of ${live[0].app.label} owned by ${live[0].owner}`,
        )
      } else {
        selfHolders.push({
          address,
          authAddr: account.authAddr?.toString(),
          localStateApps: localStates.map((state) => state.id),
        })
      }
    }

    nextToken = data.nextToken
    if (nextToken && (data.accounts ?? []).length === 0) break
  } while (nextToken)

  for (const warning of escrowLikeWarnings(selfHolders)) console.warn(`  ⚠ ${warning}`)
  console.log(
    `  ${holders} fxALGO holders: ${cached} from the cache, ${fresh} resolved fresh; ` +
      `${[...verifiedPerApp].map(([label, n]) => `${n} ${label}`).join(', ')} escrows verified, ${selfHolders.length} plain holders`,
  )
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} escrow resolution(s) disagree with the chain:\n${errors.map((e) => `  ${e}`).join('\n')}`,
    )
  }
}

/**
 * Replay from the newest committed snapshot to the current round and diff against live holdings,
 * then cross-check the beneficiary cache.
 * @throws if any holder's replayed balance differs from the chain's, or any resolution disagrees
 */
export async function verifyAgainstChain(
  indexer: Indexer,
  store: XalgoSnapshotStore,
  beneficiaries: BeneficiaryMap,
): Promise<void> {
  const baseRound = store.latestSnapshotRound()
  console.log(`\nVerifying xALGO replay against live chain state (base snapshot: ${baseRound})\n`)

  console.log('Fetching live asset balances…')
  const [xalgo, fxalgo] = await Promise.all([
    fetchLiveHoldings(indexer, XALGO_ASA_ID, 'xALGO'),
    fetchLiveHoldings(indexer, FXALGO_ASA_ID, 'fxALGO'),
  ])

  // The two balance fields are independent, so each asset is replayed to the round its
  // holder set was served at — no cross-asset synchronization needed.
  console.log(`\nReplaying transfers…`)
  const balances = getAllSnapshotBalances(store.readSnapshot(baseRound))
  await scanAssetTransfers(indexer, XALGO_ASA_ID, baseRound, xalgo.round + 1n, (batch) => {
    for (const transfer of batch) applyTransfer(balances, transfer, 'xalgo')
  })
  await scanAssetTransfers(indexer, FXALGO_ASA_ID, baseRound, fxalgo.round + 1n, (batch) => {
    for (const transfer of batch) applyTransfer(balances, transfer, 'fxalgo')
  })

  const liveBalances: BalanceMap = new Map()
  for (const [address, amount] of xalgo.holdings) liveBalances.set(address, { xalgo: amount, fxalgo: 0n })
  for (const [address, amount] of fxalgo.holdings) {
    const entry = liveBalances.get(address) ?? { xalgo: 0n, fxalgo: 0n }
    entry.fxalgo = amount
    liveBalances.set(address, entry)
  }
  const diffs = diffBalances(balances, liveBalances)
  if (diffs.length > 0) {
    throw new Error(`${diffs.length} holder(s) differ from the chain:\n${diffs.join('\n')}`)
  }
  console.log(
    `\n✓ Replay matches the chain: every holder's balance is exact ` +
      `(xALGO at round ${xalgo.round}, fxALGO at round ${fxalgo.round})`,
  )

  await verifyBeneficiaries(indexer, beneficiaries)
  console.log('\n✓ Escrow resolution matches the chain')
}
