/**
 * Unregister a committee from a GGovRegistry: deletes the committee's superbox pages and its
 * metadata box, reclaiming the box MBR.
 *
 * Admin-only: the contract's `unregisterCommittee` checks the caller is the registry admin, so
 * the DEPLOYER environment account must be that admin.
 *
 * The contract refuses to unregister a committee that still has ingested votes
 * (ERR:G_IVNZ / errIngestedVotesNotZero). Pass `--uningest` to uningest every gov first
 * (reverse ingestion order, sent by the SDK helper) and then unregister in one go.
 *
 * Usage (localnet):
 *   cd projects/ggov-sdk
 *   npx tsx examples/unregister-committee.ts <committeeIdBase64>
 *   npx tsx examples/unregister-committee.ts <committeeIdBase64> --uningest
 *
 * List committee IDs with examples/committee-ids.ts. The registry is APP_ID if set, otherwise
 * the one created by DEPLOYER; AlgorandClient config comes from the AlgoKit environment.
 */
import { GGovRegistrySDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'

void (async () => {
  const committeeIdArg = process.argv[2]
  const uningestFirst = process.argv.includes('--uningest')

  if (!committeeIdArg || committeeIdArg.startsWith('--')) {
    console.error('Usage: npx tsx examples/unregister-committee.ts <committeeIdBase64> [--uningest]')
    console.error('  --uningest  uningest all govs first (required if the committee has ingested votes)')
    process.exit(1)
  }
  // Base64 committee id, as printed by examples/committee-ids.ts — the SDK decodes and
  // length-checks it (32 bytes) via committeeIdToRaw.
  const committeeId = committeeIdArg

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const registryAppId = await resolveRegistryAppId(algorand, deployer.addr)

  const sdk = new GGovRegistrySDK({
    algorand,
    registryAppId,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    debug: true,
  })
  console.log(`Connected to registry app ${registryAppId} as ${deployer.addr}`)

  const metadata = await sdk.getCommitteeMetadata(committeeId)
  if (!metadata) {
    console.error(`Committee ${committeeId} is not registered on app ${registryAppId}.`)
    process.exit(1)
  }
  console.log({
    committeeId,
    numericId: metadata.numericId,
    periodStart: metadata.periodStart,
    periodEnd: metadata.periodEnd,
    totalMembers: metadata.totalMembers,
    totalVotes: metadata.totalVotes,
    ingestedVotes: metadata.ingestedVotes,
  })

  if (metadata.ingestedVotes !== 0) {
    if (!uningestFirst) {
      console.error(
        `Committee has ${metadata.ingestedVotes} ingested votes — unregisterCommittee would fail. ` +
          `Re-run with --uningest to remove its govs first.`,
      )
      process.exit(1)
    }
    const govs = await sdk.getCommitteeGovs(committeeId)
    console.log(`Uningesting ${govs.length} govs...`)
    await sdk.uningestCommitteeGovs({ committeeId, accounts: govs.map(({ account }) => account.toString()) })
    console.log('Uningest done.')
  }

  const { txIds } = await sdk.unregisterCommittee({ committeeId })
  console.log(`Unregistered committee ${committeeId} (txn ${txIds[txIds.length - 1]})`)

  const after = await sdk.getCommitteeMetadata(committeeId)
  console.log(after === null ? 'Committee metadata box is gone.' : `Unexpected: metadata still present ${after}`)
})()
