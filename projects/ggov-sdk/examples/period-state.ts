/**
 * List the state of every live period on a GGovRegistry.
 *
 * Read-only: builds a GGovRegistryReaderSDK (empty signer) and prints registry
 * globals (admin/operator/lastPeriodId + current round) followed by one row per
 * live period summary (periodId, app id, voting window, topic count, ready flag).
 * Deleted periods (summary.appId === 0) are skipped by getAllPeriodSummaries().
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/period-state.ts
 *
 * The registry is APP_ID if set, otherwise the one created by DEPLOYER. AlgorandClient
 * config comes from the AlgoKit environment (defaults to localnet).
 */
import { GGovRegistryReaderSDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'

/** Format a uint32 unix timestamp (0 = unset) as an ISO string for display. */
function fmtTime(secs: number | bigint): string {
  const n = Number(secs)
  return n === 0 ? '—' : new Date(n * 1000).toISOString()
}

;(async () => {
  const algorand = getAlgorand()
  const registryAppId = await resolveRegistryAppId(algorand)
  const sdk = new GGovRegistryReaderSDK({ algorand, registryAppId })

  console.log(`Registry app: ${sdk.appId}`)

  const global = await sdk.getGlobalState()
  console.log('Registry state:', {
    admin: global.admin,
    operator: global.operator,
    lastPeriodId: global.lastPeriodId,
    currentRound: global.currentRound,
  })

  const periods = await sdk.getAllPeriodSummaries()
  console.log(`\nLive periods: ${periods.length}`)
  if (periods.length === 0) return

  const now = Math.floor(Date.now() / 1000)
  const status = (s: { votingStart: number; votingEnd: number; ready: boolean }) => {
    if (!s.ready) return 'not-ready'
    if (now < Number(s.votingStart)) return 'upcoming'
    if (now > Number(s.votingEnd)) return 'closed'
    return 'open'
  }

  console.table(
    periods.map(({ id, summary }) => ({
      periodId: Number(id),
      appId: Number(summary.appId),
      votingStart: fmtTime(summary.votingStart),
      votingEnd: fmtTime(summary.votingEnd),
      numTopics: Number(summary.numTopics),
      ready: summary.ready,
      status: status(summary),
    })),
  )
})()
