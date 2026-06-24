/**
 * Update GGovRegistry config on the deployed app: xGov registry app ID and operator address.
 *
 * Usage (localnet):
 *   npx tsx examples/set-config.ts <xGovRegistryAppId> <operatorAddress>
 *
 * Both arguments are required. Pass 0 as <xGovRegistryAppId> to skip the xGov registry update,
 * or "-" as <operatorAddress> to skip the operator update.
 *
 * The DEPLOYER environment account must be the admin (creator) of the GGovRegistry app —
 * both setters are admin-gated.
 */
import { GGovRegistrySDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'
;(async () => {
  const xGovRegistryAppIdArg = process.argv[2]
  const operatorAddressArg = process.argv[3]

  if (!xGovRegistryAppIdArg || !operatorAddressArg) {
    console.error('Usage: npx tsx examples/set-config.ts <xGovRegistryAppId> <operatorAddress>')
    console.error('  pass 0 to skip xGov registry update; pass "-" to skip operator update')
    process.exit(1)
  }

  const xGovRegistryAppId = BigInt(xGovRegistryAppIdArg)
  const operatorAddress = operatorAddressArg === '-' ? null : operatorAddressArg

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  // Registry: APP_ID env if set, otherwise the registry created by this deployer.
  const appId = await resolveRegistryAppId(algorand, deployer.addr)
  console.log({ registryAppId: appId })

  const sdk = new GGovRegistrySDK({
    algorand,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    registryAppId: appId,
    debug: true,
  })

  if (xGovRegistryAppId !== 0n) {
    console.log(`Setting xGov registry app ID → ${xGovRegistryAppId}`)
    await sdk.setXGovRegistryApp({ appId: xGovRegistryAppId })
  } else {
    console.log('Skipping xGov registry app update (arg was 0)')
  }

  if (operatorAddress !== null) {
    console.log(`Setting operator → ${operatorAddress}`)
    await sdk.setOperator({ account: operatorAddress })
  } else {
    console.log('Skipping operator update (arg was "-")')
  }

  console.log('Done.')
})()
