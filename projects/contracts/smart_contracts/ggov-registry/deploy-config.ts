import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovSDK, GGovRegistrySDK } from 'ggov-sdk'

// Cross-app links (xGovRegistryApp, fracRegistryApp) are set by wireRegistries in
// ../wire-registries.ts, after every deploy config has run.
export async function deploy() {
  console.log('\n=== Deploying GGovRegistry ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const { appClient } = await GGovRegistrySDK.createRegistry({
    algorand,
    deployer: { sender: deployer.addr, signer: deployer.signer },
    operatorAccount: deployer.addr.toString(),
    initialFundingAlgos: 50, // optional: defaults to 10 ALGO (covers approval-box MBR + base)
    update: true,
  })
  console.log(`GGovRegistry app id ${appClient.appId} (${appClient.appAddress})`)
  // Combined SDK for period ops; registry ops go through sdk.registry.
  const sdk = new GGovSDK({
    algorand,
    registryAppId: appClient.appId,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
  })

  // If the registry already has periods, update each one's on-chain app code to the
  // latest GGovPeriod bytecode bundled with this ggov-sdk build (createRegistry only
  // refreshed the bytecode stored on the registry, not the already-deployed period apps).
  const summaries = await sdk.registry.getAllPeriodSummaries()
  if (summaries.length === 0) {
    console.log('Registry has no periods to update')
  } else {
    console.log(`Updating ${summaries.length} period app(s) to the latest GGovPeriod build`)
    for (const { id } of summaries) {
      const appId = await sdk.getPeriodAppId(id)
      await sdk.updatePeriodApp({ periodId: id })
      console.log(`Updated period app ${appId} (periodId ${id})`)
    }
  }

  return appClient.appId
}
