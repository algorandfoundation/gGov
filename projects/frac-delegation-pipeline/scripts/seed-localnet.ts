/**
 * Seed a localnet with the two registries and a gGov committee the pipeline can actually reconcile,
 * so `run()` has real work to do end to end without anything being deployed to mainnet.
 *
 * USAGE
 *   pnpm seed-localnet-data
 *
 * ENV
 *   Reads from env.test, a read-only mainnet env.
 *   Everything this script deploys goes to localnet.
 *
 * REQUIREMENTS
 *   Algokit localnet running, both SDKs built (`algokit project run build` builds all projects).
 *
 * WHY THE ESCROWS ARE REAL MAINNET ADDRESSES
 *   The pipeline computes `escrowsInCommittee` as the intersection of the committee's govs with what
 *   discovery finds — and discovery always reads mainnet. Generated addresses can never intersect it,
 *   so the escrow slots carry real reti pool and tALGO account addresses, read off mainnet here.
 *
 *   They are inert on localnet: escrows never sign and never need a balance, `registerEscrow` only
 *   writes a box keyed by the address, and `importFracDelegations` requires the escrow to be a known
 *   gov within the GGovRegistry, which is dictated by the committee file. Every other account is
 *   generated, with its mnemonic written to the seed file.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   No frac instances, no AlgoQuarters files, no periods. Creating the instances and registering
 *   their escrows is the pipeline's job, as well as calculating and ingesting AQ for the given
 *   committee. Govs are not funded either: nothing in this seed votes.
 *
 * STEPS
 * 1) Reset localnet and derive the deployer + gov accounts.
 * 2) Read the chosen pool/account escrows off mainnet.
 * 3) Deploy both registries, wired to each other in both directions.
 * 4) Upload the committee: generated govs + the real escrows.
 * 5) Write the seed file and print the summary.
 */

import { execSync } from 'node:child_process'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovRegistrySDK } from 'ggov-sdk'
import { FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import {
  CjsAlgorandClient,
  COMMITTEE_PERIOD_END,
  COMMITTEE_PERIOD_START,
  ESCROW_VOTES,
  GOV_VOTES,
  algosdk,
  byInstance,
  configLogger,
  deterministicAccount,
  fetchEscrows,
  hex,
  instanceNames,
  num,
  printSections,
  writeSeedFile,
  type SeedAccount,
} from './seed-common.ts'

configLogger()

// =========================================================
// SEED DEFINITION
// =========================================================

/**
 * Shape of the staking sources whose escrows are present in the committee. Since this is the first seed,
 * all of the instances are created and all escrows are registered for the first time.
 */
const SOURCES = {
  /** Reti validator ids. Every pool of each becomes an escrow. */
  reti: [1, 2, 15],
  /** tALGO `account_N` slots. */
  talgo: [0, 1],
}

/** ALGO for the deployer. It is the only account that signs anything here. */
const DEPLOYER_FUNDING = 300

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/5] ${label}`)

async function main() {
  step('Resetting LocalNet…')
  execSync('algokit localnet reset', { stdio: 'inherit' })
  await new Promise((r) => setTimeout(r, 3000)) // give localnet a moment to come back up

  const algorand = CjsAlgorandClient.defaultLocalNet()
  const network = await algorand.client.network()
  const dispenser = await algorand.account.localNetDispenser()

  const govLabels = Object.keys(GOV_VOTES)
  const accounts = new Map<string, SeedAccount>()
  for (const label of ['deployer', ...govLabels]) {
    const account = deterministicAccount(label)
    accounts.set(label, account)
    algorand.account.setSignerFromAccount(algosdk.mnemonicToSecretKey(account.mnemonic))
  }
  const addr = (label: string) => accounts.get(label)!.address
  const deployer = addr('deployer')

  step('Reading real escrows off mainnet…')

  // The ESM client: reti-ghost-sdk resolves a different algosdk than the CJS SDKs above.
  const escrows = await fetchEscrows(AlgorandClient.fromEnvironment(), SOURCES)
  const escrowInstances = instanceNames(escrows)

  step('Deploying registries…')

  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: deployer,
    amount: DEPLOYER_FUNDING.algos(),
  })
  const deployerAccount = { sender: deployer, signer: algorand.account.getSigner(deployer) }

  const { sdk, appClient: gGovRegistryApp } = await GGovRegistrySDK.createRegistry({
    algorand,
    deployer: deployerAccount,
    operatorAccount: deployer,
    initialFundingAlgos: 50n,
  })
  const { appClient: fracRegistryApp } = await FracDelegationRegistrySDK.createRegistry({
    algorand,
    deployer: deployerAccount,
    defaultOperatorAccount: deployer,
    gGovRegistryAppId: gGovRegistryApp.appId, // frac → gGov, wired at deploy time
    initialFundingAlgos: 50n,
  })
  await sdk.setFracRegistryApp({ appId: fracRegistryApp.appId }) // gGov → frac, the other direction

  step('Uploading committee file…')

  const govs = [
    ...govLabels.map((label) => ({ address: addr(label), votes: GOV_VOTES[label] })),
    ...escrows.map((e) => ({ address: e.address, votes: ESCROW_VOTES })),
  ]
  const committeeFile: GGovCommitteeFile = {
    networkGenesisHash: network.genesisHash,
    periodStart: COMMITTEE_PERIOD_START,
    periodEnd: COMMITTEE_PERIOD_END,
    registryId: Number(gGovRegistryApp.appId),
    totalMembers: govs.length,
    totalVotes: govs.reduce((sum, g) => sum + g.votes, 0),
    govs,
  }
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)
  const committeeIdB64 = Buffer.from(committeeId).toString('base64')

  step('Writing seed file…')

  writeSeedFile({
    gGovRegistryAppId: Number(gGovRegistryApp.appId),
    fracRegistryAppId: Number(fracRegistryApp.appId),
    committeeId: committeeIdB64,
    // What the pipeline should create on its first run against this seed.
    expectedInstances: byInstance(escrows),
    accounts: Object.fromEntries(
      [...accounts.values()].map((a) => [a.label, { address: a.address, mnemonic: a.mnemonic }]),
    ),
  })

  // Print summary of the seed
  const sections: { label: string; rows: string[] }[] = []
  const section = (label: string, ...rows: string[]) => sections.push({ label, rows })
  const escrowVotes = escrows.length * ESCROW_VOTES

  section(
    'REGISTRIES',
    `gGov  ${gGovRegistryApp.appId}  ${gGovRegistryApp.appAddress}`,
    `frac  ${fracRegistryApp.appId}  ${fracRegistryApp.appAddress}`,
    `deployer ${deployer}`,
    `deployer is admin + operator of both`,
  )
  section(
    'COMMITTEE',
    committeeIdB64,
    `0x${hex(committeeId)}`,
    `${committeeFile.totalMembers} members · ${num(committeeFile.totalVotes)} votes · rounds ${num(COMMITTEE_PERIOD_START)}–${num(COMMITTEE_PERIOD_END)}`,
    `${govLabels.length} generated govs · ${escrows.length} real escrows holding ${num(escrowVotes)} votes`,
  )
  const nameWidth = Math.max(...escrowInstances.map((i) => i.length)) + 2
  section(
    'ESCROWS',
    ...byInstance(escrows).flatMap(({ name, escrows: addresses }) =>
      addresses.map((address, i) => (i === 0 ? name : '').padEnd(nameWidth) + address),
    ),
  )

  printSections('FRAC PIPELINE LOCALNET SEED', sections)
  console.log('Seed details on .localnet-seed.json.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
