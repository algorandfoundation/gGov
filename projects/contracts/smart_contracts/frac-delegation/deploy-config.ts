import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationRegistrySDK, FracDelegationSDK } from 'frac-delegation-sdk'
import type { Address } from 'algosdk'
import { appIdFromEnv } from '../deploy-utils'

// Resolve the gGov registry app id: GGOV_REGISTRY_APP_ID env var takes precedence,
// otherwise look up the GGovRegistry app deployed by the same DEPLOYER account
// (ggov-registry deploys before frac-delegation per DEPLOY_ORDER in index.ts).
async function resolveGGovRegistryAppId(algorand: AlgorandClient, creator: Address): Promise<bigint | undefined> {
  const override = appIdFromEnv('GGOV_REGISTRY_APP_ID')
  if (override !== undefined) {
    console.log(`Using gGov registry app id ${override} from GGOV_REGISTRY_APP_ID`)
    return override
  }
  const lookup = await algorand.appDeployer.getCreatorAppsByName(creator)
  const gGovRegistry = lookup.apps['GGovRegistry']
  if (gGovRegistry) {
    console.log(`Using gGov registry app id ${gGovRegistry.appId} deployed by ${creator}`)
    return gGovRegistry.appId
  }
  return undefined
}

export async function deploy() {
  console.log('=== Deploying FracRegistry ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const writerAccount = { sender: deployer.addr, signer: deployer.signer }

  const gGovRegistryAppId = await resolveGGovRegistryAppId(algorand, deployer.addr)
  if (gGovRegistryAppId === undefined) {
    console.warn(
      'No gGov registry found: gGovRegistryApp will be left unconfigured. ' +
        'Set GGOV_REGISTRY_APP_ID (or deploy ggov-registry with the same DEPLOYER) and redeploy, ' +
        'or call setGGovRegistryApp directly.',
    )
  }

  const { appClient } = await FracDelegationRegistrySDK.createRegistry({
    algorand,
    deployer: writerAccount,
    defaultOperatorAccount: deployer.addr.toString(),
    gGovRegistryAppId,
    initialFundingAlgos: 50, // optional: defaults to 10 ALGO (covers approval-box MBR + base)
    update: true,
  })
  console.log(`FracDelegationRegistry app id ${appClient.appId} (${appClient.appAddress})`)
  // Combined SDK for instance ops; registry ops go through sdk.registry.
  const sdk = new FracDelegationSDK({
    algorand,
    registryAppId: appClient.appId,
    writerAccount,
  })

  // If the registry already has instances, update each one's on-chain app code to the
  // latest FracDelegationInstance bytecode bundled with this fractional-delegation-sdk
  // build (createRegistry only refreshed the bytecode stored on the registry, not the
  // already-deployed instance apps).
  const instances = await sdk.registry.getExistingInstances()
  if (instances.size === 0) {
    console.log('Registry has no instances to update')
  } else {
    console.log(`Updating ${instances.size} instance app(s) to the latest FracDelegationInstance build`)
    for (const [id, instance] of instances) {
      await sdk.updateInstanceApp({ instanceNumId: id })
      console.log(`Updated instance app ${instance.appId} (instanceId ${id})`)
    }
  }
}
