import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovSDK } from 'ggov-sdk'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log('=== Deploying GGovRegistry ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const { sdk, appClient } = await GGovSDK.createRegistry({
    algorand,
    deployer: { sender: deployer.addr, signer: deployer.signer },
    operatorAccount: deployer.addr.toString(),
    // xGovRegistryAppId: 1234n, // optional: pre-configure the xGov registry app id
    initialFundingAlgos: 50, // optional: defaults to 10 ALGO (covers approval-box MBR + base)
    update: true,
  })

  // If the registry already has periods, update each one's on-chain app code to the
  // latest GGovPeriod bytecode bundled with this ggov-sdk build (createRegistry only
  // refreshed the bytecode stored on the registry, not the already-deployed period apps).
  const summaries = await sdk.getAllPeriodSummaries()
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
}
