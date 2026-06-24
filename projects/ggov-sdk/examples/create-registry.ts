/**
 * Minimal bootstrap example for GGovSDK.createRegistry().
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/create-registry.ts
 *
 * GGovSDK.createRegistry() bundles four otherwise-manual steps into one call:
 *   1. Deploy GGovRegistry app via the typed factory
 *   2. Seed the registry's account MBR
 *   3. Compile the latest GGovPeriod approval bytecode and upload it (chunked) into a
 *      registry box. createPeriod reads the approval bytes from this box at spawn time,
 *      so admins can upgrade the GGovPeriod approval program later without redeploying
 *      the registry — call sdk.uploadPeriodApprovalProgram() with the new bytecode.
 *   4. Optionally setOperator and setXGovRegistryApp.
 */
import { GGovSDK } from '..'
import { getAlgorand } from './env'
;(async () => {
  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const { sdk, appClient } = await GGovSDK.createRegistry({
    algorand,
    deployer: { sender: deployer.addr, signer: deployer.signer },
    operatorAccount: deployer.addr.toString(),
    // xGovRegistryAppId: 1234n, // optional: pre-configure the xGov registry app id
    initialFundingAlgos: 50, // optional: defaults to 10 ALGO (covers approval-box MBR + base)
  })

  console.log('Registry deployed:', appClient.appId)
  console.log('Registry app address:', appClient.appAddress)
  console.log('Operator:', deployer.addr.toString())
  console.log('SDK is ready to addPeriod/setOperator/etc. via this writer:', deployer.addr.toString())
  // The returned `sdk` is a writer-enabled GGovSDK pre-bound to the new registry app id.
  void sdk
})()
