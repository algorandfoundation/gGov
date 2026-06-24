/**
 * List all active delegations stored on a GGovRegistry.
 *
 * Read-only: builds a GGovRegistryReaderSDK (empty signer) and calls
 * getAllDelegations(), which scans the registry's `d`-prefixed delegation boxes
 * and batch-resolves each delegator → delegatee. Prints one row per delegation
 * plus a per-delegatee tally of how many accounts delegate to them.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/delegations-state.ts
 *
 * The registry is APP_ID if set, otherwise the one created by DEPLOYER. AlgorandClient
 * config comes from the AlgoKit environment (defaults to localnet).
 */
import { GGovRegistryReaderSDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'
;(async () => {
  const algorand = getAlgorand()
  const registryAppId = await resolveRegistryAppId(algorand)
  const sdk = new GGovRegistryReaderSDK({ algorand, registryAppId })

  console.log(`Registry app: ${sdk.appId}`)

  const delegations = await sdk.getAllDelegations()
  console.log(`\nActive delegations: ${delegations.size}`)
  if (delegations.size === 0) return

  console.table([...delegations.entries()].map(([delegator, delegatee]) => ({ delegator, delegatee })))

  // How many accounts delegate to each delegatee.
  const tally = new Map<string, number>()
  for (const delegatee of delegations.values()) {
    tally.set(delegatee, (tally.get(delegatee) ?? 0) + 1)
  }
  console.log(`\nDelegatees: ${tally.size}`)
  console.table(
    [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([delegatee, delegators]) => ({ delegatee, delegators })),
  )
})()
