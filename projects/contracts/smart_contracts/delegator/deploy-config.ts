import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { DelegatorFactory } from '../artifacts/delegator/DelegatorClient'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log("Not deploying delegator, disabled in deploy-config.ts")
  return
  // DISABLED for now

  console.log('=== Deploying Delegator ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(DelegatorFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  // If app was just created fund the app account
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }
}
