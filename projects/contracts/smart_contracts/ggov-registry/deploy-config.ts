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
  })
}
