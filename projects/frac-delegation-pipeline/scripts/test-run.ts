/**
 * TEST RUN - Reads from mainnet, writes to localnet.
 *
 * USAGE:
 *   pnpm run seed-localnet-data
 *   pnpm run run-pipeline
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationPipeline } from '../src/pipeline.ts'
import { readFileSync } from 'node:fs'
import { FracDelegationSDK } from 'frac-delegation-sdk'

// CJS copy, rooted at the ggov-sdk dist. See `discoveryAlgorand` in FracPipelineArgs.
const require = createRequire(fileURLToPath(new URL('../../ggov-sdk/dist/index.js', import.meta.url)))
const { AlgorandClient: CjsAlgorandClient } = require('@algorandfoundation/algokit-utils') as {
  AlgorandClient: typeof AlgorandClient
}

const algorand = CjsAlgorandClient.defaultLocalNet()
const algorandMainnet = AlgorandClient.fromEnvironment()

const seedPath = fileURLToPath(new URL('../.localnet-seed.json', import.meta.url))
const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as {
  gGovRegistryAppId: number
  fracRegistryAppId: number
  committeeId: string
}

const pipeline = new FracDelegationPipeline({
  algorand,
  algorand2: algorandMainnet,
  fracRegistryAppId: seed.fracRegistryAppId,
  ggovRegistryAppId: seed.gGovRegistryAppId,
  stakingSources: ['reti', 'talgo'],
  debug: true,
})

const fracSdk = new FracDelegationSDK({ algorand, registryAppId: seed.fracRegistryAppId })

await pipeline
  .run(seed.committeeId)
  .then(async () => {
    console.log('Pipeline completed successfully')
    console.log('Cached instances:')
    console.log(pipeline.getInstancesCache())
    console.log('On-chain instances:')
    console.log(await fracSdk.registry.getInstances())
  })
  .catch((err) => {
    console.error('Pipeline failed with error:', err)
    process.exit(1)
  })
