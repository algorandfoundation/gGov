/**
 * Withdraw ALGO from a GGov contract — either the GGovRegistry app itself or one of its
 * deployed GGovPeriod apps. Both withdrawals are admin-only: the registry's `withdrawALGO`
 * is admin-gated directly, and a period's `withdrawALGO` inner-calls registry.verifyAdmin,
 * so the DEPLOYER environment account must be the registry admin (creator).
 *
 * The target contract is identified by its on-chain application id. The script locates the
 * registry (APP_ID env if set, else the one created by DEPLOYER), then:
 *   - if <appId> is the registry app  → registry.withdrawALGO
 *   - if <appId> is one of its periods → withdrawPeriodALGO (resolved appId → periodId)
 *
 * Withdrawn funds go to the DEPLOYER account unless an explicit receiver is passed.
 *
 * Usage (localnet):
 *   cd projects/ggov-sdk
 *   npx tsx examples/withdraw-algo.ts <appId> <amountAlgo> [receiverAddress]
 *
 * Examples:
 *   # withdraw 5 ALGO from app 1004 to the deployer
 *   npx tsx examples/withdraw-algo.ts 1004 5
 *   # withdraw 2.5 ALGO from period app 1012 to a specific address
 *   npx tsx examples/withdraw-algo.ts 1012 2.5 ABC...XYZ
 */
import { algo } from '@algorandfoundation/algokit-utils'
import { GGovSDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'
;(async () => {
  const appIdArg = process.argv[2]
  const amountArg = process.argv[3]
  const receiverArg = process.argv[4]

  if (!appIdArg || !amountArg) {
    console.error('Usage: npx tsx examples/withdraw-algo.ts <appId> <amountAlgo> [receiverAddress]')
    process.exit(1)
  }

  const targetAppId = BigInt(appIdArg)
  const amountAlgo = Number(amountArg)
  if (!Number.isFinite(amountAlgo) || amountAlgo <= 0) {
    console.error(`Invalid <amountAlgo>: ${amountArg} (must be a positive number of ALGO)`)
    process.exit(1)
  }
  const amount = algo(amountAlgo).microAlgo // uint64 µAlgo expected by the contract

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const receiver = receiverArg ?? deployer.addr.toString()

  // Locate the GGovRegistry (APP_ID env, else the one created by DEPLOYER) — needed even
  // for period withdrawals, since a period's withdrawALGO routes its admin check through
  // the registry.
  const registryAppId = await resolveRegistryAppId(algorand, deployer.addr)

  const sdk = new GGovSDK({
    algorand,
    registryAppId: registryAppId,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
  })
  console.log(`Connected to registry app ${registryAppId} as ${deployer.addr}`)
  console.log(`Withdrawing ${amountAlgo} ALGO (${amount} µAlgo) from app ${targetAppId} → ${receiver}`)

  if (targetAppId === registryAppId) {
    await sdk.registry.withdrawALGO({ receiver, amount })
    console.log(`Withdrew from registry app ${registryAppId}`)
    return
  }

  // Not the registry — must be one of its period apps. Map appId → periodId.
  const summaries = await sdk.getAllPeriodSummaries()
  const match = summaries.find(({ summary }) => BigInt(summary.appId) === targetAppId)
  if (!match) {
    const known = summaries.map(({ id, summary }) => `${summary.appId} (periodId ${id})`).join(', ')
    throw new Error(
      `App ${targetAppId} is neither the registry (${registryAppId}) nor a known period app. ` +
        `Known period apps: ${known || '(none)'}`,
    )
  }

  await sdk.withdrawPeriodALGO({ periodId: match.id, receiver, amount })
  console.log(`Withdrew from period app ${targetAppId} (periodId ${match.id})`)
})()
