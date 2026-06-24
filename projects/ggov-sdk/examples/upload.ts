import { GGovRegistrySDK } from '..'
import { getAlgorand, resolveRegistryAppId } from './env'
import { readFileSync } from 'fs'
void (async () => {
  const file = JSON.parse(readFileSync(process.argv[2], 'utf-8'))

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const appId = await resolveRegistryAppId(algorand, deployer.addr)

  console.log({ appId })
  const { balance } = await algorand.account.getInformation(deployer.addr)
  console.log('Deployer', deployer.addr.toString(), 'balance:', balance.algos)

  const sdk = new GGovRegistrySDK({
    algorand,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    registryAppId: appId,
    debug: true,
  })

  await sdk.uploadCommitteeFile(file)
  const { minBalance } = await algorand.account.getInformation(sdk.writeClient!.appAddress)
  console.log({ appMinBalance: minBalance.algos })
})()
