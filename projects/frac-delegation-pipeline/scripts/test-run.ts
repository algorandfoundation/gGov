/**
 * TEST RUN - Reads from mainnet, writes to localnet.
 *
 * USAGE:
 *   pnpm run seed-localnet
 *   pnpm run test-pipeline
 *
 * Always runs against whatever committee the `.localnet-seed.json` file currently names,
 * so `pnpm add-committee` followed by `pnpm test-pipeline` moves it on to the next one.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationPipeline } from '../src/pipeline.ts'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { CjsAlgorandClient, readSeedFile, configLogger } from './seed-common.ts'

configLogger()

const algorand = CjsAlgorandClient.defaultLocalNet()
const algorandMainnet = AlgorandClient.fromEnvironment()

const seed = readSeedFile()
console.log(`Running against committee ${seed.committeeId}`)

const pipeline = new FracDelegationPipeline({
  algorand,
  discoveryClient: algorandMainnet,
  fracRegistryAppId: seed.fracRegistryAppId,
  ggovRegistryAppId: seed.gGovRegistryAppId,
  stakingSources: ['reti', 'talgo'],
  debug: true,
})

const fracSdk = new FracDelegationSDK({ algorand, registryAppId: seed.fracRegistryAppId })

await pipeline
  .run(seed.committeeId)
  .then(async () => {
    console.log('\nPipeline completed successfully!')
    console.log(`\nCreated instances:`)
    console.log(pipeline.ctx.createdInstances)
    console.log(`\nNew escrows registered to existing instances:`)
    console.log(pipeline.ctx.existingInstanceNewEscrows)
    console.log(`\nInstances fetched from chain:`)
    console.log(await fracSdk.registry.getInstances())
  })
  .catch((err) => {
    console.error('Pipeline failed with error:', err)
    process.exit(1)
  })
