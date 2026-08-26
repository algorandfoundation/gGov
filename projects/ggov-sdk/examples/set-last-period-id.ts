/**
 * Set the GGovRegistry period-id counter: the next createPeriod issues `newLastPeriodId + 1`.
 *
 * Admin-only — the contract's `setLastPeriodId` checks the caller is the registry admin, so the
 * DEPLOYER environment account must be that admin.
 *
 * Primary use: continue numbering contiguously after a legacy system — set 15 on a fresh registry
 * so new periods start at 16. The counter can also be rewound: a downward move re-issues the ids
 * in (newLastPeriodId, lastPeriodId], and the contract refuses (ERR:G_PIR / errPeriodInRange) if
 * any of those still has a live period box. This script checks that range first and lists the
 * offending periods instead of letting the call fail opaquely.
 *
 * Usage (localnet):
 *   cd projects/ggov-sdk
 *   npx tsx examples/set-last-period-id.ts <newLastPeriodId>
 *
 * The registry is APP_ID if set, otherwise the one created by DEPLOYER. AlgorandClient config
 * comes from the AlgoKit environment (defaults to localnet).
 */
import { GGovRegistrySDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'

void (async () => {
  const newLastPeriodIdArg = process.argv[2]
  if (!newLastPeriodIdArg || !/^\d+$/.test(newLastPeriodIdArg)) {
    console.error('Usage: npx tsx examples/set-last-period-id.ts <newLastPeriodId>')
    console.error('  e.g. 15 → the next created period gets id 16')
    process.exit(1)
  }
  const newLastPeriodId = BigInt(newLastPeriodIdArg)

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

  const { lastPeriodId } = await sdk.getGlobalState()
  const current = BigInt(lastPeriodId ?? 0)
  console.log(`Current lastPeriodId: ${current} → next createPeriod would issue ${current + 1n}`)

  if (current === newLastPeriodId) {
    console.log('Already at the requested value — nothing to do.')
    return
  }

  // A downward move re-issues ids in (newLastPeriodId, current]; the contract rejects it if any
  // still holds a live period. Surface which ones, rather than failing on-chain.
  if (newLastPeriodId < current) {
    const blocking = (await sdk.getAllPeriodSummaries()).filter(({ id }) => id > newLastPeriodId)
    if (blocking.length > 0) {
      console.error(
        `Refusing to rewind to ${newLastPeriodId}: ids in (${newLastPeriodId}, ${current}] still have ` +
          `live periods: ${blocking.map(({ id, summary }) => `${id} (app ${summary.appId})`).join(', ')}. ` +
          `Delete them first (examples/delete-app.ts), then re-run.`,
      )
      process.exit(1)
    }
    console.log(`Rewinding: ids ${newLastPeriodId + 1n}..${current} are free and will be re-issued.`)
  }

  const { txIds } = await sdk.setLastPeriodId({ newLastPeriodId })
  console.log(`Set lastPeriodId → ${newLastPeriodId} (txn ${txIds[txIds.length - 1]})`)

  const { lastPeriodId: after } = await sdk.getGlobalState()
  console.log(`Confirmed lastPeriodId: ${after} → next createPeriod issues ${BigInt(after ?? 0) + 1n}`)
})()
