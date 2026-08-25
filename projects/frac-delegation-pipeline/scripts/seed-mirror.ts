/**
 * MIRROR SEED — mainnet governance state on localnet or testnet, with synthetic stand-ins.
 *
 * Uploads the real gGov committee and runs the whole pipeline (instances, delegations,
 * AlgoQuarters) against registries on the target network, like `seed-full-instances` — but every
 * account nobody can sign for on that network is replaced 1:1 by a generated one whose mnemonic is
 * written to `.synthetic-accounts.<network>.json`, together with a note of its voting power:
 *
 *   core governors  swapped when escreg says the address is an app escrow AND it is not one of
 *                   the committee's frac escrows (pool escrows stay real — stage 1 recognizes
 *                   instances by them, stage 2 delegates them)
 *   frac governors  swapped when escreg says the address is an app escrow, OR the account is a
 *                   Tinyman liquidity pool (rekeyed to XSKED5…VDEYM)
 *   either          swapped when it is one of the Algorand Foundation's accounts
 *                   (src/mirror/foundation-accounts.ts)
 *
 * Votes and AlgoQuarters are carried over unchanged. Synthetic accounts are NOT funded.
 *
 * USAGE
 *   pnpm seed-mirror [committee-file]                   # localnet (default)
 *   NETWORK=testnet DEPLOYER_MNEMONIC=… GGOV_REGISTRY_APP_ID=… FRAC_REGISTRY_APP_ID=… pnpm seed-mirror
 *
 * ENV (write side — `.env.test` keeps supplying the mainnet discovery client)
 *   NETWORK                localnet | testnet (default localnet)
 *   WRITE_ALGOD_SERVER/PORT/TOKEN   testnet algod (default Nodely testnet)
 *   DEPLOYER_MNEMONIC      required on testnet; the registries' admin + operator. Localnet uses the
 *                          deterministic deployer, topped up from the dispenser.
 *   GGOV_REGISTRY_APP_ID / FRAC_REGISTRY_APP_ID   required on testnet; on localnet, absent means
 *                          "deploy and wire both", with periods numbered from 16 (no localnet reset).
 *   SOURCES                comma-separated staking sources (default all), e.g. SOURCES=talgo
 *   CONCURRENCY            pipeline concurrency (default 4)
 *
 * RESUMABLE: the synthetic accounts file is the resume state — it is written after every generated
 * account, so a re-run reuses the same stand-ins, reproduces the same committee id and manifests,
 * and the (resumable) committee upload and pipeline finish what is left.
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { createRequire } from 'node:module'
import type { EscregSDK as EscregSDKType } from '@d13co/escreg-sdk'
import { GGovRegistrySDK, calculateCommitteeId } from 'ggov-sdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import { FracDelegationSDK, FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { FracDelegationPipeline, type AqAccountMapper } from '../src/pipeline.ts'
import { AVAILABLE_SOURCES, getPlugin } from '../src/plugins/index.ts'
import { FracAccountClassifier, algodAuthAddrLookup, classifyCoreGovs } from '../src/mirror/classify.ts'
import { SubstitutionBook, rewriteCommittee } from '../src/mirror/substitutions.ts'
import {
  algosdk,
  configLogger,
  deterministicAccount,
  hex,
  networkFromEnv,
  num,
  printSections,
  writeClient,
} from './seed-common.ts'

configLogger()

// The package's ESM build imports without file extensions, which plain Node ESM (this script runs
// under `node --experimental-strip-types`, no bundler) refuses; its CJS build resolves fine.
const { EscregSDK } = createRequire(import.meta.url)('@d13co/escreg-sdk') as {
  EscregSDK: typeof EscregSDKType
}

const DEFAULT_COMMITTEE_FILE = fileURLToPath(
  new URL('../../common/committee-files/61000000-64000000.json', import.meta.url),
)

const NETWORK = networkFromEnv()

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)
const SOURCES = process.env.SOURCES ? process.env.SOURCES.split(',').map((s) => s.trim()) : AVAILABLE_SOURCES

/**
 * Localnet-only: the id the first period created on the deployed gGov registry gets. Legacy
 * governance ran 15 periods, so a mirror continues the numbering at 16 (the registry's period
 * counter is seeded to 15, as production's is) — the council election preview is then period #16.
 */
const FIRST_PERIOD_ID = 16
/** Localnet-only: the deployer is topped up to this floor at the start of every run (see seed-full-instances). */
const DEPLOYER_FLOOR_ALGOS = 3_000n
/** Per-member top-up of the gGov registry app before the committee upload, matching the uploader. */
const MICROALGOS_PER_MEMBER = 40_000n
/** Creator-side MBR every instance creation lands on the frac registry app itself, rounded up. */
const MICROALGOS_PER_INSTANCE_ON_REGISTRY = 1_000_000n
/** Instance MBR the pipeline pays per created instance, forwarded to the child app. */
const MICROALGOS_PER_INSTANCE = 1_000_000n
/** Approximate box MBR per AQ account (instance + registry side), for the testnet estimate only. */
const MICROALGOS_PER_AQ_ACCOUNT = 26_600n

const outputPath = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url))
const SYNTHETIC_FILE = outputPath(`.synthetic-accounts.${NETWORK}.json`)
const SEED_FILE = outputPath(`.mirror-seed.${NETWORK}.json`)

const algo = (micro: bigint) => `${(Number(micro) / 1e6).toFixed(2)} ALGO`

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/7] ${label}`)

function deployerMnemonic(): string {
  if (NETWORK === 'localnet') return deterministicAccount('deployer').mnemonic
  const mnemonic = process.env.DEPLOYER_MNEMONIC
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC is required on testnet')
  return mnemonic
}

function envAppId(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`)
  return id
}

async function main() {
  step('Reading committee file…')

  const committeePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_COMMITTEE_FILE
  const realCommittee = JSON.parse(fs.readFileSync(committeePath, 'utf-8')) as GGovCommitteeFile
  const realCommitteeIdB64 = Buffer.from(calculateCommitteeId(JSON.stringify(realCommittee))).toString('base64')
  console.log(
    `  ${committeePath}\n  ${realCommitteeIdB64} (mainnet id) · ${num(realCommittee.totalMembers)} members · ` +
      `${num(realCommittee.totalVotes)} votes · rounds ${num(realCommittee.periodStart)}–${num(realCommittee.periodEnd)}`,
  )

  const mainnet = AlgorandClient.fromEnvironment()
  const { lastRound } = await mainnet.client.algod.status().do()
  if (lastRound < BigInt(realCommittee.periodEnd)) {
    throw new Error(
      `Committee window is still open: mainnet is at round ${num(Number(lastRound))}, ` +
        `periodEnd is ${num(realCommittee.periodEnd)} — stage 3 cannot run yet`,
    )
  }

  step(`Connecting to ${NETWORK} and resolving registries…`)

  const algorand = writeClient(NETWORK)
  const mnemonic = deployerMnemonic()
  const deployerKey = algosdk.mnemonicToSecretKey(mnemonic)
  algorand.account.setSignerFromAccount(deployerKey)
  const deployer = deployerKey.addr.toString()
  const deployerAccount = { sender: deployer, signer: algorand.account.getSigner(deployer) }

  const topUpDeployer = async () => {
    if (NETWORK !== 'localnet') return
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
  await topUpDeployer()

  let gGovRegistryAppId = envAppId('GGOV_REGISTRY_APP_ID')
  let fracRegistryAppId = envAppId('FRAC_REGISTRY_APP_ID')
  if (!gGovRegistryAppId || !fracRegistryAppId) {
    if (NETWORK !== 'localnet') {
      throw new Error(
        'GGOV_REGISTRY_APP_ID and FRAC_REGISTRY_APP_ID are required on testnet (registries are not deployed here)',
      )
    }
    if (gGovRegistryAppId || fracRegistryAppId) throw new Error('Set both registry app ids or neither')
    console.log(
      `  no registry app ids given: deploying and wiring both on localnet (periods start at #${FIRST_PERIOD_ID})`,
    )
    const created = await GGovRegistrySDK.createRegistry({
      algorand,
      deployer: deployerAccount,
      operatorAccount: deployer,
      initialFundingAlgos: 50n,
      firstPeriodId: FIRST_PERIOD_ID,
    })
    const { appClient: fracRegistryApp } = await FracDelegationRegistrySDK.createRegistry({
      algorand,
      deployer: deployerAccount,
      defaultOperatorAccount: deployer,
      gGovRegistryAppId: created.appClient.appId,
      initialFundingAlgos: 50n,
    })
    await created.sdk.setFracRegistryApp({ appId: fracRegistryApp.appId })
    gGovRegistryAppId = Number(created.appClient.appId)
    fracRegistryAppId = Number(fracRegistryApp.appId)
  }

  const sdk = new GGovRegistrySDK({
    algorand,
    registryAppId: BigInt(gGovRegistryAppId),
    writerAccount: deployerAccount,
  })
  const fracSdk = new FracDelegationSDK({ algorand, registryAppId: fracRegistryAppId, writerAccount: deployerAccount })

  // Fail before spending anything: every write below is admin- or operator-only.
  const gGovState = await sdk.getGlobalState()
  const roles = {
    gGovAdmin: await sdk.getAdmin(),
    gGovOperator: gGovState.operator ?? '',
    fracAdmin: await fracSdk.registry.getAdmin(),
    fracOperator: await fracSdk.registry.getDefaultOperator(),
  }
  const wrong = Object.entries(roles).filter(([, addr]) => addr !== deployer)
  if (wrong.length) {
    throw new Error(
      `Deployer ${deployer} must be admin and operator of both registries; mismatched: ` +
        wrong.map(([role, addr]) => `${role}=${addr}`).join(', '),
    )
  }
  console.log(`  gGov registry ${gGovRegistryAppId} · frac registry ${fracRegistryAppId} · deployer ${deployer}`)

  step('Opening the synthetic accounts book…')

  const book = SubstitutionBook.open(SYNTHETIC_FILE, { network: NETWORK, gGovRegistryAppId, fracRegistryAppId })
  console.log(`  ${SYNTHETIC_FILE}\n  ${book.size} synthetic accounts on file${book.size ? ' (resuming)' : ''}`)

  step('Swapping core governors…')

  // Stage 1's own recognition: whatever a source claims is an escrow stays real. Every source is
  // asked, not just SOURCES: the book persists across runs, so swapping a pool escrow because its
  // source was left out of this run would hide it from a later full run's discovery.
  const govAddresses = realCommittee.govs.map((g) => g.address)
  const escrowAddresses = new Set<string>()
  const expectedInstances = new Set<string>()
  for (const source of AVAILABLE_SOURCES) {
    const plugin = await getPlugin(source, mainnet, undefined, CONCURRENCY)
    const found = await plugin.getInstanceNameFromEscrowAddrs(govAddresses)
    for (const [escrow, instance] of Object.entries(found)) {
      escrowAddresses.add(escrow)
      if (SOURCES.includes(source)) expectedInstances.add(instance)
    }
    console.log(
      `  ${source}: ${Object.keys(found).length} escrows in the committee${SOURCES.includes(source) ? '' : ' (kept real; source not run)'}`,
    )
  }

  // Escreg's Fnet registry covers every network's app ids; escrow addresses derive from the app id
  // alone, so mainnet addresses resolve regardless of where the SDK's own client points.
  const escreg = new EscregSDK({})
  const coreSwaps = await classifyCoreGovs({
    addresses: govAddresses,
    escrowAddresses,
    escreg,
    concurrency: CONCURRENCY,
  })
  for (const gov of realCommittee.govs) {
    const verdict = coreSwaps.get(gov.address)
    if (!verdict) continue
    book.getOrCreate(gov.address, verdict.reason, verdict.appId)
    book.addVotingPower(gov.address, { kind: 'core', votes: gov.votes, totalVotes: realCommittee.totalVotes })
  }
  const committeeFile = rewriteCommittee(realCommittee, book.addressMap())
  const committeeId = calculateCommitteeId(JSON.stringify(committeeFile))
  const committeeIdB64 = Buffer.from(committeeId).toString('base64')
  book.setCommitteeIds({ committeeId: committeeIdB64, realCommitteeId: realCommitteeIdB64 })
  console.log(
    `  ${coreSwaps.size} of ${num(realCommittee.totalMembers)} members swapped: ` +
      `${[...coreSwaps.values()].filter((v) => v.reason === 'app-escrow').length} app escrows outside the frac registry, ` +
      `${[...coreSwaps.values()].filter((v) => v.reason === 'foundation').length} Algorand Foundation accounts` +
      ` (${escrowAddresses.size} frac escrows kept real)\n  synthetic committee id ${committeeIdB64}`,
  )

  step('Funding the registries and uploading the committee…')

  await topUpDeployer()

  const memberMbr = MICROALGOS_PER_MEMBER * BigInt(committeeFile.totalMembers)
  const instanceMbr = (MICROALGOS_PER_INSTANCE_ON_REGISTRY + MICROALGOS_PER_INSTANCE) * BigInt(expectedInstances.size)
  const { balance: deployerBalance } = await algorand.account.getInformation(deployer)
  console.log(
    `  deployer balance ${algo(deployerBalance.microAlgo)} · known costs: members ${algo(memberMbr)} + ` +
      `${expectedInstances.size} instances ${algo(instanceMbr)}; plus ~${algo(MICROALGOS_PER_AQ_ACCOUNT)} per AQ account ` +
      `(unknown until stage 3 — xALGO alone is ~8k accounts)`,
  )
  if (deployerBalance.microAlgo < memberMbr + instanceMbr + 10_000_000n) {
    throw new Error(
      `Deployer holds ${algo(deployerBalance.microAlgo)}, below the known ${algo(memberMbr + instanceMbr)} + 10 ALGO fees`,
    )
  }

  const fundApp = async (label: string, appId: number, target: (minBalance: bigint) => bigint) => {
    const address = algosdk.getApplicationAddress(BigInt(appId)).toString()
    const info = await algorand.account.getInformation(address)
    const shortfall = target(info.minBalance.microAlgo) - info.balance.microAlgo
    if (shortfall <= 0n) return
    await algorand.send.payment({ sender: deployer, receiver: address, amount: microAlgos(shortfall) })
    console.log(`  funded ${label} app +${algo(shortfall)}`)
  }
  await fundApp(
    'frac registry',
    fracRegistryAppId,
    (min) => min + MICROALGOS_PER_INSTANCE_ON_REGISTRY * BigInt(expectedInstances.size),
  )
  await fundApp('gGov registry', gGovRegistryAppId, (min) => min + memberMbr)

  const uploadedId = await sdk.uploadCommitteeFile(committeeFile)
  if (Buffer.from(uploadedId).toString('base64') !== committeeIdB64) {
    throw new Error('Uploaded committee id does not match the one computed from the rewritten file')
  }

  printSections(`MIRROR SEED — ${NETWORK.toUpperCase()}`, [
    { label: 'REGISTRIES', rows: [`gGov  ${gGovRegistryAppId}`, `frac  ${fracRegistryAppId}`, `deployer ${deployer}`] },
    {
      label: 'COMMITTEE',
      rows: [
        `${committeeIdB64} (synthetic) · 0x${hex(committeeId)}`,
        `${realCommitteeIdB64} (mainnet)`,
        `${num(committeeFile.totalMembers)} members · ${num(committeeFile.totalVotes)} votes · ${coreSwaps.size} swapped`,
      ],
    },
  ])

  step('Running the pipeline (stages 1-3) with frac governor swaps…')

  const classifier = new FracAccountClassifier(escreg, algodAuthAddrLookup(mainnet), CONCURRENCY)
  const fracSwapCounts = { 'app-escrow': 0, 'tinyman-pool': 0, foundation: 0 }
  const mapAqAccounts: AqAccountMapper = async (accounts, { source, instanceName }) => {
    const verdicts = await classifier.classify(Object.keys(accounts))
    if (verdicts.size === 0) return accounts
    const totalAlgoQuarters = Object.values(accounts)
      .reduce((sum, aq) => sum + BigInt(aq), 0n)
      .toString()
    const mapped: Record<string, number> = {}
    for (const [real, aq] of Object.entries(accounts)) {
      const verdict = verdicts.get(real)
      if (!verdict) {
        mapped[real] = aq
        continue
      }
      const synthetic = book.getOrCreate(real, verdict.reason, verdict.appId)
      book.addVotingPower(real, {
        kind: 'frac',
        instance: instanceName,
        source,
        algoQuarters: aq.toString(),
        totalAlgoQuarters,
      })
      mapped[synthetic.address] = aq
      fracSwapCounts[verdict.reason]++
    }
    console.log(`  ${instanceName}: swapped ${verdicts.size} of ${Object.keys(accounts).length} AQ accounts`)
    return mapped
  }

  const pipeline = new FracDelegationPipeline({
    algorand,
    discoveryClient: mainnet,
    fracRegistryAppId,
    ggovRegistryAppId: gGovRegistryAppId,
    stakingSources: SOURCES,
    concurrency: CONCURRENCY,
    adminAccount: deployerAccount,
    mapAqAccounts,
    debug: true,
  })
  await pipeline.run(committeeIdB64)

  step('Reporting…')

  const aq = pipeline.upsertAqCtx
  console.log(
    `\nCreated instances: ${pipeline.upsertInstancesCtx.createdInstances.map((i) => i.instance).join(', ') || 'none'}`,
  )
  console.log(`gGov delegations imported: ${pipeline.upsertDelegationsCtx.delegationsImported.length}`)
  console.log(
    `AlgoQuarters ingested: ${aq.uploaded.map((r) => `${r.instanceName} (${r.calculated?.totalAccounts} accounts)`).join(', ') || 'none'}`,
  )
  console.log(`AlgoQuarters already complete: ${aq.alreadyComplete.map((r) => r.instanceName).join(', ') || 'none'}`)

  const byKind = { core: 0, frac: 0 }
  for (const account of book.accounts) for (const p of account.votingPower) byKind[p.kind]++
  printSections('SYNTHETIC ACCOUNTS', [
    {
      label: 'SWAPPED',
      rows: [
        `${book.size} synthetic accounts`,
        `core governors  ${byKind.core}`,
        `frac governors  ${byKind.frac} entries this run: ${fracSwapCounts['app-escrow']} app escrows, ${fracSwapCounts['tinyman-pool']} Tinyman pools, ${fracSwapCounts.foundation} Foundation accounts`,
      ],
    },
    { label: 'FILES', rows: [SYNTHETIC_FILE, SEED_FILE] },
  ])

  fs.writeFileSync(
    SEED_FILE,
    `${JSON.stringify(
      {
        network: NETWORK,
        gGovRegistryAppId,
        fracRegistryAppId,
        committeeId: committeeIdB64,
        realCommitteeId: realCommitteeIdB64,
        expectedInstances: pipeline.upsertInstancesCtx.futureInstances.map(({ name, escrowAddresses }) => ({
          name,
          escrows: escrowAddresses,
        })),
        ...(NETWORK === 'localnet' ? { accounts: { deployer: { address: deployer, mnemonic } } } : {}),
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
