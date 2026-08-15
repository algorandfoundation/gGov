/**
 * Upload the next gGov committee onto the localnet that `seed-localnet` already seeded, and point
 * the seed file at it. Tweak SOURCES and run it again to repeat a new committee cycle.
 *
 * A pipeline run against an empty frac registry happens exactly once, ever. Every run after it meets
 * instances and escrows that are already there, so this is the steady state, not an edge case — and
 * the first run is the outlier. Most of the reconciliation logic only executes from here on.
 *
 * USAGE
 *   pnpm add-committee
 *
 * REQUIREMENTS
 *   `pnpm seed-localnet` first, then `pnpm test-pipeline` (which creates the instances this
 *   committee then reuses). This script does NOT reset localnet — the whole point is to land on top
 *   of the state the previous run left behind.
 *
 * WHAT THE SOURCES BELOW ARE FOR
 *   Dictates the sources that are present in the committee. This is the script parameter.
 *   The default covers: gaining an escrow, losing one, gaining a whole instance, dropping
 *   out entirely, or not changing at all.
 *
 * STEPS
 * 1) Read the seed file and reattach the deployer's signer.
 * 2) Read the new committee's escrows off mainnet.
 * 3) Upload the committee.
 * 4) Update the seed file and print what the next run should do.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovRegistrySDK } from 'ggov-sdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import {
  COMMITTEE_PERIOD_END,
  COMMITTEE_PERIOD_START,
  ESCROW_VOTES,
  GOV_VOTES,
  byInstance,
  configLogger,
  deterministicAccount,
  fetchEscrows,
  hex,
  instanceNames,
  num,
  printSections,
  readSeedFile,
  writeSeedFile,
} from './seed-common.ts'

configLogger()

/** This committee's escrows. */
const SOURCES = {
  // A: #1 unchanged · C: #2 and #15 dropped · E: #66 and 255 are new
  reti: [1, 66, 225],
  // B: slot 1 dropped · D: slot 2 is new
  talgo: [0, 2],
}

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/4] ${label}`)

async function main() {
  step('Reading seed file…')

  const seed = readSeedFile()
  const algorand = AlgorandClient.defaultLocalNet()
  const network = await algorand.client.network()

  // The registries were created by the first seed's deployer, so only it can upload a committee.
  const deployer = algorand.account.fromMnemonic(seed.accounts.deployer.mnemonic)
  const deployerAccount = { sender: deployer.addr.toString(), signer: deployer.signer }

  const sdk = new GGovRegistrySDK({
    algorand,
    registryAppId: BigInt(seed.gGovRegistryAppId),
    writerAccount: deployerAccount,
  })

  // A stale seed file outlives the localnet it describes; fail here rather than several calls deep.
  try {
    await algorand.app.getById(BigInt(seed.gGovRegistryAppId))
  } catch {
    throw new Error(
      `gGov registry ${seed.gGovRegistryAppId} does not exist on localnet — re-run \`pnpm seed-localnet\``,
    )
  }

  step('Reading escrows off mainnet…')

  const escrows = await fetchEscrows(AlgorandClient.fromEnvironment(), SOURCES)

  // What changed relative to the previous committee, derived rather than restated so they cannot drift.
  const before = new Set(seed.expectedInstances.flatMap((i) => i.escrows))
  const added = escrows.filter((e) => !before.has(e.address))
  const knownInstances = new Set(seed.expectedInstances.map((i) => i.name))
  const newInstances = instanceNames(escrows).filter((name) => !knownInstances.has(name))
  const addedToExisting = added.filter((e) => knownInstances.has(e.instance))

  step('Uploading committee file…')

  const govLabels = Object.keys(GOV_VOTES)
  const govs = [
    ...govLabels.map((label) => ({ address: deterministicAccount(label).address, votes: GOV_VOTES[label] })),
    ...escrows.map((e) => ({ address: e.address, votes: ESCROW_VOTES })),
  ]
  const committeeFile: GGovCommitteeFile = {
    networkGenesisHash: network.genesisHash,
    // Move the window on from the previous committee's.
    periodStart: COMMITTEE_PERIOD_START + 3_000_000,
    periodEnd: COMMITTEE_PERIOD_END + 3_000_000,
    registryId: seed.gGovRegistryAppId,
    totalMembers: govs.length,
    totalVotes: govs.reduce((sum, g) => sum + g.votes, 0),
    govs,
  }
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)
  const committeeIdB64 = Buffer.from(committeeId).toString('base64')

  step('Updating seed file…')

  // Overwrite rather than append: the pipeline runs against the current committee, and the next
  // `add-committee` diffs against this one.
  writeSeedFile({ ...seed, committeeId: committeeIdB64, expectedInstances: byInstance(escrows) })

  const sections: { label: string; rows: string[] }[] = []
  const section = (label: string, ...rows: string[]) => sections.push({ label, rows })

  section(
    'COMMITTEE',
    committeeIdB64,
    `0x${hex(committeeId)}`,
    `${committeeFile.totalMembers} members · ${num(committeeFile.totalVotes)} votes · rounds ${num(committeeFile.periodStart)}–${num(committeeFile.periodEnd)}`,
    `${govLabels.length} generated govs · ${escrows.length} real escrows`,
  )

  const nameWidth = Math.max(...instanceNames(escrows).map((i) => i.length)) + 2
  section(
    'ESCROWS',
    ...byInstance(escrows).flatMap(({ name, escrows: addresses }) =>
      addresses.map((address, i) => (i === 0 ? name : '').padEnd(nameWidth) + address),
    ),
  )

  // a new instance brings its own escrows; the rest land one by one on instances that already exist
  const newEscrows = escrows.filter((e) => newInstances.includes(e.instance)).length + addedToExisting.length
  section(
    'EXPECT',
    `creates    ${newInstances.length ? newInstances.join(', ') : 'nothing'}`,
    `registers  ${newEscrows} escrows`,
  )

  printSections('FRAC PIPELINE LOCALNET — NEW COMMITTEE', sections)
  console.log(`Ready — seed details on .localnet-seed.json.\n`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
