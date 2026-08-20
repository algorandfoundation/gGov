/**
 * FULL TEST RUN — production mirror.
 *
 * Seeds localnet with the two registries and the REAL gGov committee file for the latest mainnet
 * window (61,000,000–64,000,000), then runs the whole pipeline against it: the same work a
 * production run would do, with mainnet discovery and data, and localnet contracts.
 *
 * Unlike `pnpm seed-localnet-data` (synthetic committee: generated govs plus hand-picked escrows),
 * this uploads the committee file production would upload — same content, so same committee id —
 * and stage 1 discovers exactly the escrows the real committee contains, stage 2 points their gGov
 * delegations at their instances, and stage 3 ingests the window's real AlgoQuarters.
 *
 * USAGE
 *   pnpm seed-full-instances                       # seed (or resume) + stages 1-3
 *   pnpm seed-full-instances <committee-file>      # same, for a different committee file
 *
 * RESUMABLE
 *   Interrupted part-way — a dropped connection during the committee upload or the AQ ingest — run
 *   it again: when `.localnet-seed.json` already names this committee and its gGov registry is live
 *   on localnet, the reset + deploy is skipped and both the upload and the pipeline pick up where
 *   they left off. Any other seed state (a synthetic seed, a stale file) is replaced with a full
 *   localnet reset, exactly like `seed-localnet-data`.
 *
 * REQUIREMENTS
 *   Algokit localnet, both SDKs built (`algokit project run build`), mainnet past the committee's
 *   `periodEnd` — stage 3 replays `[periodStart, periodEnd)` and refuses an open window — and the
 *   window-start snapshots under `snapshots/` (61,000,000 for tALGO and xALGO is committed).
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { execSync } from 'node:child_process'
import { GGovRegistrySDK, calculateCommitteeId } from 'ggov-sdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import { FracDelegationSDK, FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { FracDelegationPipeline } from '../src/pipeline.ts'
import {
  algosdk,
  configLogger,
  deterministicAccount,
  hex,
  num,
  printSections,
  readSeedFile,
  writeSeedFile,
  type SeedFile,
} from './seed-common.ts'

configLogger()

/** The latest committee published for mainnet, as built by ggov-committee-uploader. */
const DEFAULT_COMMITTEE_FILE = fileURLToPath(
  new URL('../../common/committee-files/61000000-64000000.json', import.meta.url),
)

/**
 * ALGO floor the deployer is topped up to at the start of every run, resumed or not. It is admin
 * and operator of both registries, so it pays for everything: the gGov registry's member-ingest MBR
 * (~40,000 µALGO × 1,651 members ≈ 66 ALGO), 1 ALGO of MBR per instance created, and the AQ ingest
 * MBR of every account (~26,600 µALGO each — xALGO alone is ~8k accounts, ~220 ALGO). The real
 * committee decides the exact counts, so the floor is generous rather than exact; localnet's
 * dispenser has plenty.
 */
const DEPLOYER_FLOOR_ALGOS = 3_000n

/** Per-member top-up of the gGov registry app before the committee upload, matching the uploader. */
const MICROALGOS_PER_MEMBER = 40_000n

/**
 * ALGO of headroom above min balance the frac registry app is topped up to before the pipeline
 * runs. Every instance the registry creates lands ~0.9 ALGO of MBR on the REGISTRY's own account
 * (created-app params + extra program pages + the child's global schema are charged to the
 * creator; the 1 ALGO `mbrAmount` the pipeline pays is forwarded on to the child app, not kept) —
 * measured on the 61M-64M committee, whose 62 instances overran the 50 ALGO deploy funding at
 * instance #49. TODO: the pipeline's addInstance could pre-compute and autoFund this the way
 * uploadAqFile does; until then the seed pays it, as production ops would.
 */
const FRAC_REGISTRY_HEADROOM_ALGOS = 100n

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/5] ${label}`)

async function main() {
  step('Reading committee file…')

  const committeePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_COMMITTEE_FILE
  const committeeFile = JSON.parse(fs.readFileSync(committeePath, 'utf-8')) as GGovCommitteeFile
  // Same content as production, so the id — the hash of the file — is production's committee id.
  const committeeId = calculateCommitteeId(JSON.stringify(committeeFile))
  const committeeIdB64 = Buffer.from(committeeId).toString('base64')
  console.log(
    `  ${committeePath}\n  ${committeeIdB64} · ${num(committeeFile.totalMembers)} members · ` +
      `${num(committeeFile.totalVotes)} votes · rounds ${num(committeeFile.periodStart)}–${num(committeeFile.periodEnd)}`,
  )

  // Stage 3 replays [periodStart, periodEnd), so the whole window has to be on mainnet already.
  // The xALGO plugin checks this itself; tALGO does not yet, so fail the run up front instead.
  const algorandMainnet = AlgorandClient.fromEnvironment()
  const { lastRound } = await algorandMainnet.client.algod.status().do()
  if (lastRound < BigInt(committeeFile.periodEnd)) {
    throw new Error(
      `Committee window is still open: mainnet is at round ${num(Number(lastRound))}, ` +
        `periodEnd is ${num(committeeFile.periodEnd)} — stage 3 cannot run yet`,
    )
  }

  const algorand = AlgorandClient.defaultLocalNet()

  // The same deterministic deployer as the other seeds (= ADMIN in .env.test, which the pipeline
  // signs with). Admin and operator of both registries.
  const deployerSeed = deterministicAccount('deployer')
  algorand.account.setSignerFromAccount(algosdk.mnemonicToSecretKey(deployerSeed.mnemonic))
  const deployer = deployerSeed.address
  const deployerAccount = { sender: deployer, signer: algorand.account.getSigner(deployer) }

  // Top the deployer up to the floor: before the registries are deployed on a fresh localnet, and
  // again on every run — a resumed ingest spends from where the interrupted one stopped.
  const topUpDeployer = async () => {
    const dispenser = await algorand.account.localNetDispenser()
    const { balance } = await algorand.account.getInformation(deployer)
    const target = DEPLOYER_FLOOR_ALGOS * 1_000_000n
    if (balance.microAlgo < target) {
      await algorand.send.payment({
        sender: dispenser.addr,
        receiver: deployer,
        amount: microAlgos(target - balance.microAlgo),
      })
    }
  }

  // Resume rather than reseed when the seed file already names THIS committee and its registry is
  // live — that is a prior run of this script, and everything downstream is resumable on top of it.
  let seed: SeedFile | undefined
  try {
    seed = readSeedFile()
  } catch {
    seed = undefined
  }
  let resume = false
  if (seed?.committeeId === committeeIdB64) {
    try {
      await algorand.app.getById(BigInt(seed.gGovRegistryAppId))
      resume = true
    } catch {
      resume = false // stale seed file outliving its localnet: reseed
    }
  }

  let sdk: GGovRegistrySDK
  let seedFile: SeedFile
  if (resume) {
    step('Resuming on the existing seed (no reset)…')
    seedFile = seed!
    sdk = new GGovRegistrySDK({
      algorand,
      registryAppId: BigInt(seedFile.gGovRegistryAppId),
      writerAccount: deployerAccount,
    })
  } else {
    step('Resetting LocalNet and deploying registries…')
    execSync('algokit localnet reset', { stdio: 'inherit' })
    await new Promise((r) => setTimeout(r, 3000)) // give localnet a moment to come back up
    await topUpDeployer() // the deployer pays for everything from here on

    const created = await GGovRegistrySDK.createRegistry({
      algorand,
      deployer: deployerAccount,
      operatorAccount: deployer,
      initialFundingAlgos: 50n,
    })
    sdk = created.sdk
    const { appClient: fracRegistryApp } = await FracDelegationRegistrySDK.createRegistry({
      algorand,
      deployer: deployerAccount,
      defaultOperatorAccount: deployer,
      gGovRegistryAppId: created.appClient.appId, // frac → gGov, wired at deploy time
      initialFundingAlgos: 50n,
    })
    await sdk.setFracRegistryApp({ appId: fracRegistryApp.appId }) // gGov → frac, the other direction

    seedFile = {
      gGovRegistryAppId: Number(created.appClient.appId),
      fracRegistryAppId: Number(fracRegistryApp.appId),
      committeeId: committeeIdB64,
      expectedInstances: [], // discovery's to find: filled in from the run's results below
      accounts: { deployer: { address: deployer, mnemonic: deployerSeed.mnemonic } },
    }
    writeSeedFile(seedFile)
  }

  step('Funding and uploading the committee…')

  await topUpDeployer()

  // Instance creation piles MBR onto the frac registry app itself (see FRAC_REGISTRY_HEADROOM_ALGOS):
  // give it room for every instance the committee implies before stage 1 starts creating them.
  const fracAppAddress = algosdk.getApplicationAddress(BigInt(seedFile.fracRegistryAppId)).toString()
  const fracInfo = await algorand.account.getInformation(fracAppAddress)
  const fracTarget = fracInfo.minBalance.microAlgo + FRAC_REGISTRY_HEADROOM_ALGOS * 1_000_000n
  if (fracInfo.balance.microAlgo < fracTarget) {
    const fracShortfall = fracTarget - fracInfo.balance.microAlgo
    await algorand.send.payment({ sender: deployer, receiver: fracAppAddress, amount: microAlgos(fracShortfall) })
    console.log(`  funded frac registry app +${(Number(fracShortfall) / 1e6).toFixed(2)} ALGO for instance MBR`)
  }

  // Ingesting members grows the registry app's box MBR, paid by the app itself via inner txns:
  // top the app up for the whole committee before uploading (same estimate as the uploader).
  const appAddress = sdk.writeClient!.appAddress.toString()
  const appInfo = await algorand.account.getInformation(appAddress)
  const appTarget = appInfo.minBalance.microAlgo + MICROALGOS_PER_MEMBER * BigInt(committeeFile.totalMembers)
  const appShortfall = appTarget - appInfo.balance.microAlgo
  if (appShortfall > 0n) {
    await algorand.send.payment({ sender: deployer, receiver: appAddress, amount: microAlgos(appShortfall) })
    console.log(`  funded gGov registry app +${(Number(appShortfall) / 1e6).toFixed(2)} ALGO for member MBR`)
  }

  // Registers the committee and ingests its govs — itself resumable, so a re-run finishes a
  // partial upload and a complete one is a no-op.
  const uploadedId = await sdk.uploadCommitteeFile(committeeFile)
  if (Buffer.from(uploadedId).toString('base64') !== committeeIdB64) {
    throw new Error('Uploaded committee id does not match the one computed from the file')
  }

  printSections('FRAC PIPELINE FULL RUN — PRODUCTION MIRROR', [
    {
      label: 'REGISTRIES',
      rows: [
        `gGov  ${seedFile.gGovRegistryAppId}`,
        `frac  ${seedFile.fracRegistryAppId}`,
        `deployer ${deployer} (admin + operator of both)`,
        resume ? 'resumed on the existing localnet seed' : 'fresh localnet',
      ],
    },
    {
      label: 'COMMITTEE',
      rows: [
        committeeIdB64,
        `0x${hex(committeeId)}`,
        `${num(committeeFile.totalMembers)} members · ${num(committeeFile.totalVotes)} votes · ` +
          `rounds ${num(committeeFile.periodStart)}–${num(committeeFile.periodEnd)}`,
      ],
    },
  ])

  step('Running the pipeline (stages 1-3)…')

  const pipeline = new FracDelegationPipeline({
    algorand,
    discoveryClient: algorandMainnet,
    fracRegistryAppId: seedFile.fracRegistryAppId,
    ggovRegistryAppId: seedFile.gGovRegistryAppId,
    stakingSources: ['reti', 'talgo', 'xalgo'],
    debug: true,
  })
  const fracSdk = new FracDelegationSDK({ algorand, registryAppId: seedFile.fracRegistryAppId })

  await pipeline.run(committeeIdB64)

  step('Reporting…')

  console.log('\nPipeline completed successfully!')
  console.log(`\nCreated instances:`)
  console.log(pipeline.upsertInstancesCtx.createdInstances)
  console.log(`\nNew escrows registered to existing instances:`)
  console.log(pipeline.upsertInstancesCtx.existingInstanceNewEscrows)
  console.log(`\ngGov delegations already in place: ${pipeline.upsertDelegationsCtx.alreadyDelegated.length}`)
  console.log(`\ngGov delegations imported:`)
  console.log(pipeline.upsertDelegationsCtx.delegationsImported)
  const aq = pipeline.upsertAqCtx
  console.log(`\nAlgoQuarters ingested:`)
  console.log(
    aq.uploaded.map(({ instanceName, calculated, committeeAq }) => ({
      instance: instanceName,
      accounts: calculated?.totalAccounts,
      algoQuarters: calculated?.totalAlgoQuarters,
      onChain: committeeAq && `${committeeAq.ingestedAq} AQ / ${committeeAq.numAccounts} accounts`,
    })),
  )
  console.log(`\nAlgoQuarters already complete: ${aq.alreadyComplete.map((r) => r.instanceName).join(', ') || 'none'}`)
  console.log(
    `AlgoQuarters skipped (source has no AQ support): ${aq.skippedNoAqSupport.map((r) => r.instanceName).join(', ') || 'none'}`,
  )
  console.log(`\nInstances fetched from chain:`)
  console.log(await fracSdk.registry.getInstances())

  // What discovery found is what the next run should expect: record it like the other seeds do.
  writeSeedFile({
    ...seedFile,
    expectedInstances: pipeline.upsertInstancesCtx.futureInstances.map(({ name, escrowAddresses }) => ({
      name,
      escrows: escrowAddresses,
    })),
  })
  console.log('\nSeed details on .localnet-seed.json.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
