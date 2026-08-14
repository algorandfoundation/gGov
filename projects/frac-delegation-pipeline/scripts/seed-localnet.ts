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

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { RetiGhostSDK } from 'reti-ghost-sdk'
import { GGovRegistrySDK } from 'ggov-sdk'
import { FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import { RETI_REGISTRY_APP_ID, TALGO_APP_ID } from '../src/pipeline.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// CJS copy for everything touching the local SDKs, rooted at the ggov-sdk dist.
// See `discoveryAlgorand` in FracPipelineArgs for why the realms have to stay apart.
const require = createRequire(fileURLToPath(new URL('../../ggov-sdk/dist/index.js', import.meta.url)))
const { AlgorandClient: CjsAlgorandClient, Config } = require('@algorandfoundation/algokit-utils') as {
  AlgorandClient: typeof AlgorandClient
  Config: { configure: (c: Record<string, unknown>) => void }
}
const algosdk = require('algosdk') as typeof import('algosdk')

Config.configure({
  logger: { error: console.error, warn: console.warn, info: () => {}, verbose: () => {}, debug: () => {} },
})

// =========================================================
// SEED DEFINITION
// =========================================================

/** Namespace for deterministic key derivation. Change it and every generated address changes. */
const SEED_NAMESPACE = 'frac-pipeline-localnet'

/** Committee 1 and committee 2 windows, in rounds. */
const COMMITTEE_PERIOD_START = 60_000_000
const COMMITTEE_PERIOD_END = 63_000_000

/** Shape of the staking sources which escrows are present in the committee - what gets written on-chain. */
const SOURCES = {
  /**
   * Reti validator ids. Every pool of each becomes an escrow.
   * # of pools per validator: 1->2, 2->1, 15->1. Total escrows: 4.
   */
  reti: [1, 2, 15],
  /** tALGO `account_N` slots. Slot 0 is the app itself, so it is never a useful escrow. */
  talgo: [1, 2],
}

/** Generated committee members: label → voting power. None of them vote in this seed. */
const GOV_VOTES: Record<string, number> = {
  g1: 520,
  g2: 460,
  g3: 90,
  g4: 215,
  g5: 25,
  g6: 360,
  g7: 140,
  g8: 570,
}

/** Voting power handed to every real escrow. Escrows hold gGov power but never cast it themselves. */
const ESCROW_VOTES = 900

/** ALGO for the deployer. It is the only account that signs anything here. */
const DEPLOYER_FUNDING = 300

// =========================================================
// HELPERS
// =========================================================

const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
const num = (n: number) => n.toLocaleString('en-US')
// const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/5] ${label}`)

type SeedAccount = { label: string; address: string; sk: Uint8Array; mnemonic: string }

/** Derive an account from its label alone, so every run yields the same addresses and mnemonics. */
function deterministicAccount(label: string): SeedAccount {
  const seed = new Uint8Array(createHash('sha512-256').update(`${SEED_NAMESPACE}:${label}`).digest())
  const mnemonic = algosdk.mnemonicFromSeed(seed)
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic)
  return { label, address: addr.toString(), sk, mnemonic }
}

/** An escrow the pipeline will discover: which instance it belongs to, and its real mainnet address. */
type Escrow = { instance: string; address: string; source: 'reti' | 'talgo' }

/**
 * Read the escrows named in SOURCES off mainnet. Instance names must match what the pipeline
 * generates during discovery, since the reconciliation join is on the name string.
 */
async function fetchRealEscrows(mainnet: AlgorandClient): Promise<Escrow[]> {
  const retiSdk = new RetiGhostSDK({ algorand: mainnet, registryAppId: RETI_REGISTRY_APP_ID })
  const pools = await retiSdk.getPools(SOURCES.reti)
  const reti: Escrow[] = SOURCES.reti.flatMap((validatorId, i) =>
    pools[i].map((p) => ({
      instance: `Reti #${validatorId}`,
      address: algosdk.getApplicationAddress(p.poolAppId).toString(),
      source: 'reti' as const,
    })),
  )

  const state = await mainnet.app.getGlobalState(TALGO_APP_ID)
  const talgo: Escrow[] = SOURCES.talgo.map((slot) => {
    const entry = state[`account_${slot}`]
    if (!entry || !('valueRaw' in entry)) throw new Error(`talgo: app ${TALGO_APP_ID} has no account_${slot}`)
    return { instance: 'Tinyman tALGO', address: algosdk.encodeAddress(entry.valueRaw), source: 'talgo' as const }
  })

  return [...reti, ...talgo]
}

async function main() {
  // =========================================================
  // 1. RESET & ACCOUNTS
  // =========================================================

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

  // =========================================================
  // 2. REAL ESCROWS OFF MAINNET
  // =========================================================

  step('Reading real escrows off mainnet…')

  // The ESM client: reti-ghost-sdk resolves a different algosdk than the CJS SDKs above.
  const escrows = await fetchRealEscrows(AlgorandClient.fromEnvironment())
  const escrowInstances = [...new Set(escrows.map((e) => e.instance))]

  // A repeat here would make the pipeline throw `Repeated escrows found across sources` far downstream.
  if (new Set(escrows.map((e) => e.address)).size !== escrows.length) {
    throw new Error('SOURCES produced a repeated escrow address')
  }

  // =========================================================
  // 3. REGISTRIES
  // =========================================================

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

  // =========================================================
  // 4. COMMITTEE
  // =========================================================

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

  // =========================================================
  // 5. OUTPUT
  // =========================================================

  step('Writing seed file…')

  const seedPath = path.resolve(__dirname, '../.localnet-seed.json')
  fs.writeFileSync(
    seedPath,
    `${JSON.stringify(
      {
        gGovRegistryAppId: Number(gGovRegistryApp.appId),
        fracRegistryAppId: Number(fracRegistryApp.appId),
        committeeId: committeeIdB64,
        // What the pipeline should create on its first run against this seed.
        expectedInstances: escrowInstances.map((instance) => ({
          name: instance,
          escrows: escrows.filter((e) => e.instance === instance).map((e) => e.address),
        })),
        accounts: Object.fromEntries(
          [...accounts.values()].map((a) => [a.label, { address: a.address, mnemonic: a.mnemonic }]),
        ),
      },
      null,
      2,
    )}\n`,
  )

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
    ...escrowInstances.flatMap((instance) =>
      escrows
        .filter((e) => e.instance === instance)
        .map((e, i) => (i === 0 ? instance : '').padEnd(nameWidth) + e.address),
    ),
  )
  section(
    'NEXT',
    `Run \`pnpm run-pipeline\` and expect ${escrowInstances.length} new instances created and ${escrows.length} new escrows registered`,
  )

  const gutter = Math.max(...sections.map((s) => s.label.length)) + 2
  const out = sections.flatMap(({ label, rows }) => [
    ...rows.map((row, i) => (i === 0 ? label : '').padEnd(gutter) + row),
    '',
  ])
  const rule = '═'.repeat(Math.max(...out.map((line) => line.length)))
  console.log(`\n${rule}\nFRAC PIPELINE LOCALNET SEED\n${rule}\n`)
  console.log(out.join('\n'))
  console.log(`Seed details on ${path.basename(seedPath)}.`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
