/**
 * List the committee IDs already registered on a GGovRegistry.
 *
 * Read-only: builds a GGovRegistryReaderSDK (empty signer) and scans the
 * registry's `c`-prefixed committee boxes. Pass `--meta` to also resolve each
 * committee's metadata through the SDK batch helper.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/committee-ids.ts
 *   npx tsx examples/committee-ids.ts --meta
 *
 * The registry is APP_ID if set, otherwise the one created by DEPLOYER. AlgorandClient
 * config comes from the AlgoKit environment (defaults to localnet).
 */
import { GGovRegistryReaderSDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'

void (async () => {
  const withMeta = process.argv.includes('--meta')
  const algorand = getAlgorand()
  const registryAppId = await resolveRegistryAppId(algorand).catch((err) => {
    if (!process.env.APP_ID) {
      throw new Error(
        `Could not resolve a GGovRegistry app for DEPLOYER. Set APP_ID, and set ALGOD_* if the app is not on localnet.\n${err}`,
      )
    }
    throw err
  })

  const sdk = new GGovRegistryReaderSDK({ algorand, registryAppId })
  await algorand.app.getById(registryAppId).catch((err) => {
    throw new Error(`App ${registryAppId} was not found on the configured network. Check APP_ID and ALGOD_*.\n${err}`)
  })

  const ids = await sdk.getCommitteeIds()
  console.log(`Registry app: ${sdk.appId}`)
  console.log(`\nRegistered committees: ${ids.length}`)
  if (ids.length === 0) return

  const base64Ids = ids.map((id) => Buffer.from(id).toString('base64'))

  if (!withMeta) {
    for (const id of base64Ids) console.log(id)
    return
  }

  const metas = await sdk.getCommitteesMetadata(ids)

  const table = metas
    .map((meta, i) => ({
      committeeId: base64Ids[i],
      numericId: meta?.numericId ?? null,
      periodStart: meta?.periodStart ?? null,
      periodEnd: meta?.periodEnd ?? null,
      totalMembers: meta?.totalMembers ?? null,
      totalVotes: meta?.totalVotes ?? null,
      ingestedVotes: meta?.ingestedVotes ?? null,
      xGovRegistryId: meta?.xGovRegistryId ?? null,
    }))
    .sort((a, b) => (a.numericId ?? Infinity) - (b.numericId ?? Infinity))

  console.table(table)
})()
