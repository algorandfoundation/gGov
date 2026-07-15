import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationRegistrySDK, FracDelegationSDK } from 'frac-delegation-sdk'

export async function deploy() {
  console.log('=== Deploying FracRegistry ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const writerAccount = { sender: deployer.addr, signer: deployer.signer }

  const { sdk: registrySdk } = await FracDelegationRegistrySDK.createRegistry({
    algorand,
    deployer: writerAccount,
    defaultOperatorAccount: deployer.addr.toString(),
    // gGovRegistryAppId: 1234n, // optional: pre-configure the gGov registry app id
    initialFundingAlgos: 50, // optional: defaults to 10 ALGO (covers approval-box MBR + base)
    update: true,
  })

  // If the registry already has instances, update each one's on-chain app code to the
  // latest FracDelegationInstance bytecode bundled with this fractional-delegation-sdk
  // build (createRegistry only refreshed the bytecode stored on the registry, not the
  // already-deployed instance apps).
  const instances = await registrySdk.getExistingInstances()
  if (instances.size === 0) {
    console.log('Registry has no instances to update')
  } else {
    console.log(`Updating ${instances.size} instance app(s) to the latest FracDelegationInstance build`)
    for (const [id, instance] of instances) {
      const instanceSdk = new FracDelegationSDK({
        algorand,
        instanceAppId: instance.appId,
        writerAccount,
      })
      await instanceSdk.updateInstanceApp({})
      console.log(`Updated instance app ${instance.appId} (instanceId ${id})`)
    }
  }
}
