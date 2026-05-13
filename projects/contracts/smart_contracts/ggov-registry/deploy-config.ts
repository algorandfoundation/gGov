import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovRegistryFactory } from '../artifacts/ggov-registry/GGovRegistryClient'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log('=== Deploying GGovRegistry ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  // If app was just created fund the app account
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (10).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }
}
