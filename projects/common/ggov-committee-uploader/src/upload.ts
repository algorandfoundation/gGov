/**
 * Upload built gGov committee files to the GGovRegistry app.
 *
 * Reads committee files from ./committees (produced by `pnpm build`) and
 * ingests each via the ggov-sdk. The deployer account is resolved from the
 * environment and must be the registry operator.
 *
 * Usage:
 *   pnpm upload                              # all files in ./committees
 *   pnpm upload committees/59000000-62000000.json   # specific file(s)
 *
 * Env (standard AlgoKit): ALGOD_*, INDEXER_*, DEPLOYER_MNEMONIC, etc.
 *   GGOV_REGISTRY_APP_ID   override registry app id (default: looked up by
 *                          creator + name "GGovRegistry")
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { GGovRegistryFactory, GGovRegistrySDK } from 'ggov-sdk'

import { type CommitteeFile } from './ggov'

const COMMITTEES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'committees')

function resolveFiles(): string[] {
  const args = process.argv.slice(2)
  if (args.length) return args
  return readdirSync(COMMITTEES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(COMMITTEES_DIR, f))
}

async function main() {
  const files = resolveFiles()
  if (!files.length) {
    throw new Error(`No committee files found. Run \`pnpm build\` first or pass file paths.`)
  }

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  let appId: bigint
  if (process.env.GGOV_REGISTRY_APP_ID) {
    appId = BigInt(process.env.GGOV_REGISTRY_APP_ID)
  } else {
    const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, { defaultSender: deployer.addr })
    ;({ appId } = await factory.getAppClientByCreatorAndName({
      creatorAddress: deployer.addr,
      appName: 'GGovRegistry',
    }))
  }

  const { balance } = await algorand.account.getInformation(deployer.addr)
  console.log({ appId, deployer: deployer.addr.toString(), balance: balance.algos })

  const sdk = new GGovRegistrySDK({
    algorand,
    writerAccount: { sender: deployer.addr, signer: deployer.signer },
    registryAppId: appId,
    debug: true,
  })
  // Stringify: the SDK's appAddress is an Address from its own algosdk copy,
  // which fails this project's algosdk `instanceof` check inside the composer.
  const appAddress = sdk.writeClient!.appAddress.toString()

  // Ingesting members grows the registry app's box MBR. Boxes are created by
  // inner txns that fail if the app balance is below the new min-balance, so
  // top the app up *before* each committee. Estimate per member is generous;
  // unused funds stay locked as MBR (reclaimable on localnet teardown).
  const microAlgosPerMember = BigInt(Math.round(Number(process.env.FUND_PER_MEMBER_ALGOS ?? '0.04') * 1e6))
  async function fundAppForMembers(members: number) {
    const info = await algorand.account.getInformation(appAddress)
    const target = info.minBalance.microAlgo + microAlgosPerMember * BigInt(members)
    const shortfall = target - info.balance.microAlgo
    if (shortfall > 0n) {
      await algorand.send.payment({ sender: deployer.addr, receiver: appAddress, amount: microAlgos(shortfall) })
      console.log(
        `  funded app +${(Number(shortfall) / 1e6).toFixed(3)} ALGO (target ${(Number(target) / 1e6).toFixed(2)})`,
      )
    }
  }

  for (const path of files) {
    const file = JSON.parse(readFileSync(path, 'utf-8')) as CommitteeFile
    console.log(`\nUploading ${path}  (period ${file.periodStart}-${file.periodEnd}, ${file.totalMembers} members)`)
    await fundAppForMembers(file.totalMembers)
    await sdk.uploadCommitteeFile(file)
  }

  const { minBalance } = await algorand.account.getInformation(sdk.writeClient!.appAddress)
  console.log(`\nDone. App min balance: ${minBalance.algos} ALGO`)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
