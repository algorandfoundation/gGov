/**
 * TEMPORARY — deploy-first localnet seed, to be reverted.
 *
 * A standalone copy of the seeder from `chore/frac-sample-data-scripts`
 * (`scripts/deploy-sample-data.ts`), restructured so **every app deployment happens
 * up front**. Committed on its own so this one commit can be reverted wholesale once
 * that branch's real seeder lands; nothing else depends on this file.
 *
 * WHY THE REORDER
 *   The original interleaves deployments with data: registries → committee → create
 *   instances *and* ingest AQ → delegations → create *and* populate *and* vote each
 *   period. Here the two are separated:
 *
 *     DEPLOY   reset · fund · both registries · committee file · instances + escrows
 *              · all three period apps
 *     SEED     AlgoQuarters · delegations · period bodies/topics/windows/ready
 *              · ballots · verify
 *
 *   So every app ID exists — and `.env` is written — before the slow data work starts,
 *   which means a deployment failure surfaces in seconds rather than minutes, and the
 *   frontend can be pointed at the registries while the seed is still running.
 *
 *   Two dependencies stop this being a clean "apps, then everything else" split, and
 *   both are why the committee file sits in the DEPLOY phase:
 *     - `addPeriod` needs a `committeeId`, so the committee file must be uploaded
 *       before any period app can be created.
 *     - `syncPeriod` needs the period marked ready *and* the committee already synced
 *       on the instance, so it stays in the SEED phase with the rest of the period work.
 *
 * USAGE
 *   From projects/ggov-frontend:  npx tsx scripts/deploy-frac-sample-data.ts
 *   From the repo root:           pnpm --filter ggov-frontend seed-localnet-frac
 *
 * REQUIREMENTS
 *   Algokit localnet running, and both SDKs built — `algokit project run build` at the
 *   repo root, or `pnpm --filter ggov-sdk build && pnpm --filter frac-delegation-sdk build`
 *   (this script requires their `dist/`, not their sources).
 *
 * NOT INCLUDED (the real seeder's commit carries these; skip or port by hand)
 *   The `AppProviders.tsx` change that lets the frontend open the per-persona KMD
 *   wallets. Without it, connect through `unencrypted-default-wallet` — all four
 *   personas live there too.
 *
 * PERSONAS (KMD)
 *   The frontend treats every account in the connected wallet as a voter, so the four
 *   personas live together in `unencrypted-default-wallet` *and* each gets its own
 *   single-account wallet for looking at one persona in isolation:
 *
 *     deployer  admin + operator of both registries; not a gov                (ggov-deployer)
 *     alice     gov · delegatee of bob and g2 · holds AQ in both instances    (ggov-alice)
 *     bob       gov only, a plain block producer · delegated his power to alice (ggov-bob)
 *     carol     AlgoQuarters only, not a committee member                     (ggov-carol)
 *
 * CONSTRAINTS (unchanged from the original)
 *   - The first vote of either kind locks a period against setReady(false)/editPeriod, so
 *     every period is fully populated before any ballot is cast, and period 3 stays unvoted.
 *   - Keep escrows out of the ballot tables; they must never cast a direct gGov vote.
 */

import { createRequire } from 'node:module'
import { randomBytes, createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import type { GGovCommitteeFile } from 'ggov-sdk'
import type { AlgoQuartersFile } from 'frac-delegation-sdk'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Use require for packages that have CJS dist but ESM source issues.
// `as typeof import(...)` restores the types require() erases (it returns `any`); the cast is erased at runtime.
const { AlgorandClient, Config, algo } =
  require('@algorandfoundation/algokit-utils') as typeof import('@algorandfoundation/algokit-utils')
const { GGovSDK, GGovRegistrySDK } = require('../../ggov-sdk/dist/index.js') as typeof import('ggov-sdk')
const { FracDelegationSDK, FracDelegationRegistrySDK } =
  require('../../frac-delegation-sdk/dist/index.js') as typeof import('frac-delegation-sdk')
const algosdk = require('algosdk') as typeof import('algosdk')

type Kmd = InstanceType<typeof algosdk.Kmd>

Config.configure({
  logger: { error: console.error, warn: console.warn, info: () => {}, verbose: () => {}, debug: () => {} },
})

// =========================================================
// SEED DEFINITION  (verbatim from the original, so the eventual swap is a pure delete)
// =========================================================

/** Namespace for deterministic key derivation. Change it and every address in the seed changes. */
const SEED_NAMESPACE = 'ggov-localnet'

/** Committee window, in rounds. Shared by the committee file and both AlgoQuarters manifests. */
const COMMITTEE_PERIOD_START = 50_000_000
const COMMITTEE_PERIOD_END = 53_000_000

/**
 * Lifetime of period 1's voting window, in seconds: long enough to cast its ballots inside, short
 * enough that waiting for it to lapse is cheap. Overrunning it fails loudly.
 */
const ENDED_VOTING_WINDOW_SECONDS = 40

/** Persona wallets are unencrypted like the LocalNet default, so switching only needs the name. */
const PERSONA_WALLET_PASSWORD = ''

/** The four accounts that go into KMD, and so can connect from the frontend. */
const PERSONAS = ['deployer', 'alice', 'bob', 'carol']

/** Persona → its own single-account KMD wallet, for viewing that persona in isolation. */
const PERSONA_WALLETS: Record<string, string> = {
  deployer: 'ggov-deployer',
  alice: 'ggov-alice',
  bob: 'ggov-bob',
  carol: 'ggov-carol',
}

/**
 * gGov committee: account label → voting power. `alice`/`bob` are KMD personas, `g*` are plain
 * external govs, `x*` are the protocol escrows — which carry the largest single powers.
 */
const GOV_VOTES: Record<string, number> = {
  alice: 420,
  bob: 180,
  g1: 520,
  g2: 460,
  g3: 90,
  g4: 215,
  g5: 25,
  g6: 360,
  g7: 140,
  g8: 570,
  g9: 620,
  g10: 480,
  g11: 45,
  g12: 60,
  g13: 435,
  x1: 1600, // e.g LST escrow
  x2: 900, // reti escrow
  x3: 500, // reti escrow
}

/**
 * The two frac instances. Each one's AQ total is its escrows' combined gGov votes × 1000
 * (`tinyman` 1600 → 1.6M, `reti` 900+500 → 1.4M) — a seed convention, not a system rule.
 *
 * Note the deliberate overlap with the committee: g1/g4 hold tALGO and g5 stakes in a Réti pool, so
 * the gov and AQ-holder sets intersect without being the same set. u1..u10 are pure staking
 * protocol users with no gGov voting power of their own.
 *
 * `bob` holds tALGO *and* delegates to alice, which is what puts a pooled position two levels deep
 * on the ballot — alice > "bob, delegated to you" > his Tinyman share — and makes the delegated frac
 * vote reachable (alice signs, bob's AlgoQuarters are cast). His AQ comes out of u1's rather than
 * being added on top, so each instance's total still matches the convention above.
 */
const INSTANCES = [
  {
    label: 'Tinyman tALGO',
    escrows: ['x1'],
    aq: {
      alice: 120_000,
      bob: 70_000,
      carol: 85_000,
      g1: 240_000,
      g4: 60_000,
      u1: 240_000,
      u2: 145_000,
      u3: 95_000,
      u4: 260_000,
      u5: 175_000,
      u6: 110_000,
    } as Record<string, number>,
  },
  {
    label: 'Réti #42',
    escrows: ['x2', 'x3'],
    aq: {
      alice: 90_000,
      carol: 130_000,
      g5: 40_000,
      u1: 210_000,
      u2: 75_000,
      u4: 165_000,
      u6: 120_000,
      u7: 280_000,
      u8: 95_000,
      u9: 115_000,
      u10: 80_000,
    } as Record<string, number>,
  },
]

/**
 * gGov account-level delegations: delegator → delegatee. Both sides are personas you can connect
 * as: alice receives, bob hands his power over — a block producer who would rather a representative
 * voted for him, which is the ordinary reason to delegate.
 */
const DELEGATIONS: [string, string][] = [
  ['bob', 'alice'], // alice casts bob's ballot
  ['g2', 'alice'], // g2 delegates but will vote directly
]

/**
 * ALGO handed out per account class. Escrows do not need funding on this setup.
 *
 * TODO: once instance MBR on-demand is implemented, `instance` can be 0. For now, instances need
 * explicit funding for per-period vote caches and every voter's record. Same applies to `period`
 * once the upfront payment for estimated voting MBR is implemented.
 */
const FUNDING = { deployer: 300, persona: 20, gov: 5, user: 5, instance: 10, period: 5 }

/**
 * A gGov ballot, one character per topic: Y = first option, N = second, A = last (abstain).
 * `castBy` names the delegatee signing on the voter's behalf; absent means the voter signs itself.
 */
type Ballot = { voter: string; ballot: string; castBy?: string }

/** An internal frac vote: same shorthand, weighted by the voter's AlgoQuarters in that instance. */
type FracBallot = { voter: string; ballot: string; instance: string }

/**
 * Council candidates, shared by periods 1 and 2. Each is a Support/Veto/Abstain ballot;
 * candidates rank by net score (Support − Veto) for the available seats.
 */
const CANDIDATE_TOPICS = [
  { title: 'txnlab.algo', body: 'AlgoKit core maintainer and developer tooling.' },
  { title: 'folks.algo', body: 'Folks Finance lending protocol contributor.' },
  { title: 'nodely.algo', body: 'Infrastructure, indexer and node operator.' },
  { title: 'reti.algo', body: 'Reti staking pool collective.' },
  { title: 'gard.algo', body: 'GARD stablecoin protocol team.' },
]

/** Period 1: 11 of the 15 non-escrow members vote, shaped for a clean descending ranking. */
const ENDED_BALLOTS: Ballot[] = [
  { voter: 'alice', ballot: 'YYYYN' },
  { voter: 'bob', ballot: 'YYYAN', castBy: 'alice' }, // delegated: alice votes bob's power for him
  { voter: 'g2', ballot: 'YYNNA' }, // delegated to alice, votes directly anyway → alice locked out
  { voter: 'g1', ballot: 'YYYYN' },
  { voter: 'g3', ballot: 'YYNAN' },
  { voter: 'g4', ballot: 'YYYNA' },
  { voter: 'g5', ballot: 'YNNNY' },
  { voter: 'g6', ballot: 'YYYNN' },
  { voter: 'g7', ballot: 'YYANN' },
  { voter: 'g8', ballot: 'YYYAN' },
  { voter: 'g9', ballot: 'YNYNA' },
]

/** Period 1 frac votes: 670k of tinyman's 1.6M AQ and 525k of reti's 1.4M turn out; the rest abstains. */
const ENDED_FRAC_BALLOTS: FracBallot[] = [
  { instance: 'Tinyman tALGO', voter: 'alice', ballot: 'YYYAN' },
  { instance: 'Tinyman tALGO', voter: 'g1', ballot: 'YYNYN' },
  { instance: 'Tinyman tALGO', voter: 'u1', ballot: 'YYYNA' },
  { instance: 'Réti #42', voter: 'carol', ballot: 'YYYYN' },
  { instance: 'Réti #42', voter: 'u7', ballot: 'YNYNA' },
  { instance: 'Réti #42', voter: 'u9', ballot: 'YYNAN' },
]

/**
 * Period 2: only 7 direct voters so far, and bob's delegated power is untouched — connect as alice
 * to cast his ballot for him, or as bob to override by voting directly.
 */
const ACTIVE_BALLOTS: Ballot[] = [
  { voter: 'alice', ballot: 'YYYYN' },
  { voter: 'g1', ballot: 'YYYYN' },
  { voter: 'g2', ballot: 'YYYAN' },
  { voter: 'g4', ballot: 'YYYNA' },
  { voter: 'g6', ballot: 'YYNNA' },
  { voter: 'g8', ballot: 'YNNNY' },
  { voter: 'g9', ballot: 'YYYNN' },
]

/** Period 2 frac votes: tinyman has started, reti has not — carol's reti position is yours to cast. */
const ACTIVE_FRAC_BALLOTS: FracBallot[] = [
  { instance: 'Tinyman tALGO', voter: 'alice', ballot: 'YYYYN' },
  { instance: 'Tinyman tALGO', voter: 'u1', ballot: 'YYYNA' },
]

// =========================================================
// HELPERS
// =========================================================

/** Generate a random 8-byte note to deduplicate otherwise-identical transactions. */
function randomNote(): Uint8Array {
  return new Uint8Array(randomBytes(8))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
const num = (n: number) => n.toLocaleString('en-US')

const TOTAL_STEPS = 12
let stepNumber = 0
/** The only progress output inside the pipeline: one line per step, because the run takes minutes. */
const step = (label: string) => console.log(`[${String(++stepNumber).padStart(2, ' ')}/${TOTAL_STEPS}] ${label}`)

type SeedAccount = { label: string; address: string; sk: Uint8Array; mnemonic: string }

/**
 * Derive an account from its label alone, so the whole seed is reproducible: the same label always
 * yields the same address, and its mnemonic can be imported into any wallet.
 */
function deterministicAccount(label: string): SeedAccount {
  const seed = new Uint8Array(createHash('sha512-256').update(`${SEED_NAMESPACE}:${label}`).digest())
  const mnemonic = algosdk.mnemonicFromSeed(seed)
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic)
  return { label, address: addr.toString(), sk, mnemonic }
}

async function getKmdDefaultWalletHandle(kmd: Kmd): Promise<string> {
  const { wallets } = await kmd.listWallets()
  const defaultWallet = wallets.find((w: { id: string; name: string }) => w.name === 'unencrypted-default-wallet')
  if (!defaultWallet) throw new Error('Could not find unencrypted-default-wallet in KMD')
  const { wallet_handle_token } = await kmd.initWalletHandle(defaultWallet.id, '')
  return wallet_handle_token
}

/** Create a single-account KMD wallet, or top up an existing one (a localnet reset usually clears these). */
async function createPersonaWallet(kmd: Kmd, name: string, password: string, account: SeedAccount): Promise<void> {
  const { wallets } = await kmd.listWallets()
  const existing = wallets.find((w: { id: string; name: string }) => w.name === name)
  const walletId = existing?.id ?? (await kmd.createWallet(name, password)).wallet.id
  const { wallet_handle_token: handle } = await kmd.initWalletHandle(walletId, password)
  // A wallet with no keys yet omits `addresses` from the response entirely.
  const addresses: string[] = (await kmd.listKeys(handle)).addresses ?? []
  if (!addresses.includes(account.address)) await kmd.importKey(handle, account.sk)
  await kmd.releaseWalletHandle(handle)
}

/** Rewrite (or append) a VITE_ var in .env. Returns false when there is no .env to write. */
function setEnvVars(envPath: string, vars: Record<string, bigint>): boolean {
  if (!fs.existsSync(envPath)) return false
  let env = fs.readFileSync(envPath, 'utf-8')
  for (const [key, value] of Object.entries(vars)) {
    const line = new RegExp(`^${key}=.*$`, 'm')
    env = line.test(env) ? env.replace(line, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`
  }
  fs.writeFileSync(envPath, env)
  return true
}

async function main() {
  // #########################################################
  // PHASE 1 — DEPLOY
  // Everything that creates an on-chain app or identity, so a
  // failure here costs seconds and .env is usable immediately.
  // #########################################################

  // =========================================================
  // 1. RESET & ACCOUNTS
  // =========================================================

  step('Resetting LocalNet…')
  execSync('algokit localnet reset', { stdio: 'inherit' })
  await new Promise((r) => setTimeout(r, 3000)) // give localnet a moment to come back up

  const algorand = AlgorandClient.defaultLocalNet()
  const kmd = algorand.client.kmd
  const network = await algorand.client.network()

  const dispenser = await algorand.account.localNetDispenser()
  const dispenserAddress = dispenser.addr.toString()

  const govLabels = Object.keys(GOV_VOTES)
  const escrowLabels = INSTANCES.flatMap((i) => i.escrows)
  const aqHoldersLabels = [...new Set(INSTANCES.flatMap((i) => Object.keys(i.aq)))]
  const allLabels = [...new Set([...PERSONAS, ...govLabels, ...aqHoldersLabels])]

  // Derive every account up front and register its signer, so any of them can sign later.
  const accounts = new Map<string, SeedAccount>()
  for (const label of allLabels) {
    const account = deterministicAccount(label)
    accounts.set(label, account)
    algorand.account.setSignerFromAccount(algosdk.mnemonicToSecretKey(account.mnemonic))
  }
  /** Label → address. Everything downstream resolves accounts by label. */
  const addr = (label: string) => accounts.get(label)!.address
  const deployer = addr('deployer')

  // Shape the default wallet: drop the pre-seeded genesis keys other than the dispenser (their ALGO
  // stays on chain, we just stop showing them in the frontend's account switcher), then import the
  // four personas so a single connect exposes exactly them.
  const defaultHandle = await getKmdDefaultWalletHandle(kmd)
  const preSeeded: string[] = (await kmd.listKeys(defaultHandle)).addresses ?? []
  for (const a of preSeeded) if (a !== dispenserAddress) await kmd.deleteKey(defaultHandle, '', a)
  for (const label of PERSONAS) await kmd.importKey(defaultHandle, accounts.get(label)!.sk)
  await kmd.releaseWalletHandle(defaultHandle)

  // …plus one isolated wallet per persona, to see how the UI reads for a single-account holder.
  for (const [label, wallet] of Object.entries(PERSONA_WALLETS)) {
    await createPersonaWallet(kmd, wallet, PERSONA_WALLET_PASSWORD, accounts.get(label)!)
  }

  // =========================================================
  // 2. FUNDING
  // =========================================================

  step('Funding accounts…')

  const fundingPlan: { label: string; algos: number }[] = [
    { label: 'deployer', algos: FUNDING.deployer },
    ...['alice', 'bob', 'carol'].map((label) => ({ label, algos: FUNDING.persona })),
    // Personas are funded above; escrows never sign anything and the registry pays their delegation
    // MBR, so they need no balance at all.
    ...govLabels
      .filter((l) => !PERSONAS.includes(l) && !escrowLabels.includes(l))
      .map((label) => ({ label, algos: FUNDING.gov })),
    // Every AQ holder gets ALGO even if this seed never votes with it, so any of them can be
    // imported by mnemonic and used to cast an internal vote by hand.
    ...aqHoldersLabels
      .filter((l) => !PERSONAS.includes(l) && !govLabels.includes(l))
      .map((label) => ({ label, algos: FUNDING.user })),
  ]

  for (const batch of chunk(fundingPlan, 15)) {
    let group = algorand.newGroup()
    for (const { label, algos } of batch) {
      group = group.addPayment({ sender: dispenser.addr, receiver: addr(label), amount: algo(algos) })
    }
    await group.send()
  }

  // =========================================================
  // 3. REGISTRIES
  // =========================================================

  step('Deploying registries…')

  const deployerAccount = { sender: deployer, signer: algorand.account.getSigner(deployer) }

  const { appClient: gGovRegistryApp } = await GGovRegistrySDK.createRegistry({
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

  const sdk = new GGovSDK({ algorand, registryAppId: gGovRegistryApp.appId, writerAccount: deployerAccount })
  const fracSdk = new FracDelegationSDK({
    algorand,
    registryAppId: fracRegistryApp.appId,
    writerAccount: deployerAccount,
  })

  await sdk.registry.setFracRegistryApp({ appId: fracRegistryApp.appId }) // gGov → frac, wire the other direction

  /** The same SDKs bound to another signer, for votes and delegations cast by non-deployer accounts. */
  const voterSdk = (label: string) =>
    new GGovSDK({
      algorand,
      registryAppId: gGovRegistryApp.appId,
      writerAccount: { sender: addr(label), signer: algorand.account.getSigner(addr(label)) },
    })
  const fracVoterSdk = (label: string) =>
    new FracDelegationSDK({
      algorand,
      registryAppId: fracRegistryApp.appId,
      writerAccount: { sender: addr(label), signer: algorand.account.getSigner(addr(label)) },
    })

  // =========================================================
  // 4. .ENV  (the point of deploying first)
  // =========================================================

  step('Writing .env app IDs…')

  const envPath = path.resolve(__dirname, '../.env')
  const envWritten = setEnvVars(envPath, {
    VITE_GGOV_REGISTRY_APP_ID: gGovRegistryApp.appId,
    VITE_FRAC_REGISTRY_APP_ID: fracRegistryApp.appId,
  })
  console.log(
    envWritten
      ? `        gGov ${gGovRegistryApp.appId} · frac ${fracRegistryApp.appId} — start vite now if you like, the seed keeps running`
      : `        no .env found — set VITE_GGOV_REGISTRY_APP_ID=${gGovRegistryApp.appId} and VITE_FRAC_REGISTRY_APP_ID=${fracRegistryApp.appId} by hand`,
  )

  // =========================================================
  // 5. GGOV COMMITTEE
  // =========================================================

  // In the DEPLOY phase because `addPeriod` (step 7) needs a committeeId, and the instances'
  // AlgoQuarters ingest (step 8) needs the committee to exist before it can sync it.
  step('Uploading committee file…')

  const committeeFile: GGovCommitteeFile = {
    networkGenesisHash: network.genesisHash,
    periodStart: COMMITTEE_PERIOD_START,
    periodEnd: COMMITTEE_PERIOD_END,
    registryId: Number(gGovRegistryApp.appId),
    totalMembers: govLabels.length,
    totalVotes: Object.values(GOV_VOTES).reduce((a, b) => a + b, 0),
    govs: govLabels.map((label) => ({ address: addr(label), votes: GOV_VOTES[label] })),
  }
  const committeeId = (await sdk.registry.uploadCommitteeFile(committeeFile)) as Uint8Array

  // =========================================================
  // 6. FRAC INSTANCE APPS
  // =========================================================

  // App creation and escrow registration only — the AlgoQuarters manifests are data and wait for
  // step 8, which is the main thing this reorder pulls apart.
  step('Creating frac-delegation instances…')

  const instanceNumIds = new Map<string, bigint>()
  const instanceAppIds = new Map<string, bigint>()

  for (const instance of INSTANCES) {
    // Only 1 ALGO for MBR payment here; `uploadAqFile`'s `autoFund` covers the ingest in step 8.
    const instanceNumId = await fracSdk.registry.addInstance({ name: instance.label, mbrAmount: 1e6 })
    const appId = await fracSdk.getInstanceAppId(instanceNumId)
    instanceNumIds.set(instance.label, instanceNumId)
    instanceAppIds.set(instance.label, appId)

    for (const escrow of instance.escrows) {
      await fracSdk.registry.registerEscrow({ instanceNumId, account: addr(escrow) })
    }

    // TODO: remove once instance on-demand MBR is implemented. See `FUNDING`.
    await algorand.send.payment({
      sender: deployer,
      receiver: algosdk.getApplicationAddress(appId).toString(),
      amount: algo(FUNDING.instance),
      note: randomNote(),
    })
  }

  // =========================================================
  // 7. PERIOD APPS
  // =========================================================

  /**
   * Create the period app with a placeholder future window — a window that hasn't opened is the
   * only state in which topics can still be added — and fund its vote-record boxes. Everything
   * else about the period (body, topics, real window, ready, instance sync) is step 10.
   */
  async function createPeriodApp(): Promise<bigint> {
    const nowSecs = BigInt(Math.floor(Date.now() / 1000))
    const periodId = (await sdk.registry.addPeriod({
      committeeId,
      votingStart: nowSecs + 100000n,
      votingEnd: nowSecs + 200000n,
    })) as bigint
    // The period app pays MBR for one vote-record box per voter, so needs funding.
    // TODO: this extra payment won't be needed in the future. See `FUNDING`.
    const periodAppId = await sdk.getPeriodAppId(periodId)
    await algorand.send.payment({
      sender: deployer,
      receiver: algosdk.getApplicationAddress(periodAppId).toString(),
      amount: algo(FUNDING.period),
      note: randomNote(),
    })
    return periodId
  }

  step('Creating the three period apps…')

  const endedPeriodId = await createPeriodApp()
  const activePeriodId = await createPeriodApp()
  const upcomingPeriodId = await createPeriodApp()

  console.log(`        #${endedPeriodId} ended · #${activePeriodId} active · #${upcomingPeriodId} upcoming`)

  // #########################################################
  // PHASE 2 — SEED
  // Data and state on top of the apps above. Nothing here
  // creates an app, so every remaining failure is recoverable
  // without redeploying.
  // #########################################################

  // =========================================================
  // 8. ALGOQUARTERS
  // =========================================================

  step('Uploading AlgoQuarters manifests…')

  for (const instance of INSTANCES) {
    const rows = Object.entries(instance.aq)
    const aqFile: AlgoQuartersFile = {
      networkGenesisHash: network.genesisHash,
      protocol: instance.label,
      periodStart: COMMITTEE_PERIOD_START,
      periodEnd: COMMITTEE_PERIOD_END,
      totalAccounts: rows.length,
      totalAlgoQuarters: rows.reduce((sum, [, aq]) => sum + aq, 0).toString(),
      // The AQ pipeline emits its rows sorted ascending by address; mirror that.
      accounts: rows
        .map(([label, aq]) => ({ account: addr(label), algoQuarters: aq.toString() }))
        .sort((a, b) => (a.account < b.account ? -1 : 1)),
    }
    // syncCommittee → startAqIngest → ingestAq, in one call.
    await fracSdk.uploadAqFile({
      instanceNumId: instanceNumIds.get(instance.label)!,
      committeeId,
      aqFile,
      autoFund: true,
    })
  }

  // =========================================================
  // 9. DELEGATIONS
  // =========================================================

  step('Setting delegations…')

  // Point every escrow's gGov delegation at the instance it belongs to, so the instances can cast
  // externally on their behalf.
  await sdk.registry.importFracDelegationsAll({ escrowAccounts: escrowLabels.map(addr) })

  // Account-level gGov delegations between govs.
  for (const [delegator, delegatee] of DELEGATIONS) {
    await voterSdk(delegator).registry.setVotingAccount({ votingAddress: addr(delegatee) })
  }

  // =========================================================
  // 10. POPULATE PERIODS
  // =========================================================

  /**
   * Fill in an already-created period: body — with `electSeats` for a council election — topics, the
   * real voting window, ready, then snapshot it on both instances. Must run before any ballot,
   * because the first vote of either kind locks the period against editPeriod/setReady(false).
   */
  async function populatePeriod(
    periodId: bigint,
    opts: {
      title: string
      body: string
      electSeats?: number
      topics: { title: string; body: string; options?: string[] }[]
      votingStart: bigint
      votingEnd: bigint
    },
  ): Promise<void> {
    await sdk.uploadPeriodBody({
      periodId,
      body: {
        title: opts.title,
        body: opts.body,
        ...(opts.electSeats !== undefined ? { electSeats: opts.electSeats } : {}),
      },
    })
    for (const topic of opts.topics) {
      // addTopicWithBody packs addTopic + the body chunks into one atomic, single-signature group.
      // Election candidates are always Support/Veto/Abstain (mirroring the Manage UI); standard
      // topics use their own options. Either way Abstain is last, as frac voting requires.
      await sdk.addTopicWithBody({
        periodId,
        options:
          opts.electSeats !== undefined ? ['Support', 'Veto', 'Abstain'] : (topic.options ?? ['Yes', 'No', 'Abstain']),
        body: { title: topic.title, body: topic.body },
        note: randomNote(),
      })
    }
    await sdk.editPeriod({ periodId, committeeId, votingStart: opts.votingStart, votingEnd: opts.votingEnd })
    await sdk.setReady({ periodId, ready: true })

    // Snapshot the now-ready period on both instances. Without this an instance's vote() has nothing
    // to write into (ERR:GP_NX). Requires the committee already synced locally — step 8.
    const periodAppId = await sdk.getPeriodAppId(periodId)
    for (const instance of INSTANCES) {
      await fracSdk.syncPeriod({ instanceNumId: instanceNumIds.get(instance.label)!, periodApp: periodAppId })
    }
  }

  step('Populating periods…')

  const now = BigInt(Math.floor(Date.now() / 1000))

  // Populate the two periods with no clock pressure first, so period 1's short window is opened as
  // late as possible — immediately before its ballots go in (step 11).
  await populatePeriod(upcomingPeriodId, {
    title: 'Q2 2026 Governance',
    body: 'Upcoming governance period covering protocol upgrades and ecosystem strategy.',
    topics: [
      { title: 'Protocol Upgrade v2.0', body: 'Approve deployment of Protocol v2.0 (state proofs, block pipelining).' },
      {
        title: 'Ecosystem Development Fund',
        body: 'Allocate 1M ALGO to an ecosystem development fund for grants and tooling.',
      },
    ],
    votingStart: now + 86400n * 14n,
    votingEnd: now + 86400n * 28n,
  })

  await populatePeriod(activePeriodId, {
    title: 'gGov Council — Term 2 election',
    body: 'Elect 3 council members. Each candidate below is a Support/Veto/Abstain ballot; candidates are ranked by net score (Support − Veto) and the top 3 lead for the available seats.',
    electSeats: 3,
    topics: CANDIDATE_TOPICS,
    votingStart: now - 3600n,
    votingEnd: now + 86400n * 7n,
  })

  // The contract blocks editPeriod once a period is `ready` (and voting requires ready), and
  // setReady(false) is blocked once votes exist — so a voted period can't be backdated. Instead give
  // it a short window, cast within it, then let wall-clock pass votingEnd; the frontend derives
  // "ended" from votingEnd vs now.
  const endedVotingStart = BigInt(Math.floor(Date.now() / 1000))
  const endedVotingEnd = endedVotingStart + BigInt(ENDED_VOTING_WINDOW_SECONDS)
  await populatePeriod(endedPeriodId, {
    title: 'gGov Council — Term 1 election',
    body: 'Elect 3 council members. Each candidate below is a Support/Veto/Abstain ballot; candidates are ranked by net score (Support − Veto) and the top 3 took the available seats.',
    electSeats: 3,
    topics: CANDIDATE_TOPICS,
    votingStart: endedVotingStart - 3600n,
    votingEnd: endedVotingEnd,
  })

  // =========================================================
  // 11. BALLOTS
  // =========================================================

  /** One-hot row: the voter's full weight on the chosen option. Y → first, N → second, A → last. */
  const oneHot = (choice: string, weight: number, options: number) => {
    const index = choice === 'Y' ? 0 : choice === 'N' ? 1 : options - 1
    return Array.from({ length: options }, (_, i) => (i === index ? weight : 0))
  }

  /** Cast gGov ballots with each voter's committee voting power, signed by the voter or its delegatee. */
  async function castBallots(periodId: bigint, ballots: Ballot[]) {
    for (const { voter, ballot, castBy } of ballots) {
      const topicVotes = ballot.split('').map((c) => oneHot(c, GOV_VOTES[voter], 3))
      await voterSdk(castBy ?? voter).vote({ periodId, voterAccount: addr(voter), topicVotes, note: randomNote() })
    }
  }

  /**
   * Cast internal frac-delegation ballots weighted by each voter's AQ. The instance maps its internal
   * tally onto its escrows' gGov power and re-casts externally inside the same call; AQ that never vote
   * land on the last option.
   */
  async function castFracBallots(periodId: bigint, ballots: FracBallot[]) {
    for (const { instance, voter, ballot } of ballots) {
      const aq = INSTANCES.find((i) => i.label === instance)!.aq[voter]
      const topicVotes = ballot.split('').map((c) => oneHot(c, aq, 3))
      await fracVoterSdk(voter).vote({
        instanceNumId: instanceNumIds.get(instance)!,
        periodId,
        topicVotes,
        note: randomNote(),
      })
    }
  }

  step('Casting ballots…')

  // Period 1 first and without delay — its window is only ENDED_VOTING_WINDOW_SECONDS wide.
  try {
    await castBallots(endedPeriodId, ENDED_BALLOTS)
    await castFracBallots(endedPeriodId, ENDED_FRAC_BALLOTS)
  } catch (err) {
    if (Math.floor(Date.now() / 1000) < Number(endedVotingEnd)) throw err
    throw Object.assign(
      new Error(
        `Period ${endedPeriodId}'s voting window (${ENDED_VOTING_WINDOW_SECONDS}s) closed before its ballots ` +
          `were cast. Raise ENDED_VOTING_WINDOW_SECONDS. Original error: ${(err as Error).message}`,
      ),
      { cause: err },
    )
  }

  // Period 2's ballots run *inside* period 1's remaining window, so the wait below is only what is
  // left of it. On localnet that saves a couple of seconds at most — the ballots are fast and the
  // window dominates — but it costs nothing and keeps the sleep last.
  await castBallots(activePeriodId, ACTIVE_BALLOTS)
  await castFracBallots(activePeriodId, ACTIVE_FRAC_BALLOTS)

  // Wait for period 1's voting window to lapse so it reads as ENDED in the UI.
  const waitMs = Number(endedVotingEnd) * 1000 + 2000 - Date.now()
  if (waitMs > 0) {
    console.log(`        Waiting ${Math.ceil(waitMs / 1000)}s for period ${endedPeriodId}'s window to close…`)
    await new Promise((r) => setTimeout(r, waitMs))
  }

  // =========================================================
  // 12. OUTPUT
  // =========================================================

  step('Verifying and writing output…')

  // gGov demands a voter's full power on every topic, so each topic of period 1 must tally to the
  // direct voters' power plus every escrow's — members who never voted contribute nothing. The
  // escrow half only lands if both instances mapped their internal tallies out to gGov.
  const directVotes = ENDED_BALLOTS.reduce((sum, b) => sum + GOV_VOTES[b.voter], 0)
  const escrowVotes = escrowLabels.reduce((sum, label) => sum + GOV_VOTES[label], 0)
  const endedPeriod = await sdk.getPeriod(endedPeriodId)
  for (const [i, [, votes]] of endedPeriod.topics.entries()) {
    const tallied = votes.reduce((a, b) => a + b, 0)
    if (tallied !== directVotes + escrowVotes) {
      throw new Error(
        `Period ${endedPeriodId} topic ${i}: ${tallied} votes tallied, expected ${directVotes + escrowVotes} ` +
          `(${directVotes} direct + ${escrowVotes} re-cast by escrows).`,
      )
    }
  }

  /** What the seed made an account responsible for, as greppable tags. */
  const rolesOf = (label: string) => [
    ...(label === 'deployer' ? ['admin+operator'] : []),
    ...(GOV_VOTES[label] !== undefined ? [`gov:${GOV_VOTES[label]}`] : []),
    ...INSTANCES.flatMap((i) => [
      ...(i.escrows.includes(label) ? [`escrow:${i.label}`] : []),
      ...(i.aq[label] !== undefined ? [`aq:${i.label}:${i.aq[label]}`] : []),
    ]),
    ...DELEGATIONS.filter(([from]) => from === label).map(([, to]) => `delegates-to:${to}`),
    ...DELEGATIONS.filter(([, to]) => to === label).map(([from]) => `delegatee-of:${from}`),
  ]

  const manifestPath = path.resolve(__dirname, '../.localnet-seed.json')
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        gGovRegistryAppId: Number(gGovRegistryApp.appId),
        fracRegistryAppId: Number(fracRegistryApp.appId),
        committeeId: hex(committeeId),
        instances: Object.fromEntries(
          INSTANCES.map((i) => [
            i.label,
            { numId: Number(instanceNumIds.get(i.label)!), appId: Number(instanceAppIds.get(i.label)!) },
          ]),
        ),
        periods: { ended: Number(endedPeriodId), active: Number(activePeriodId), upcoming: Number(upcomingPeriodId) },
        // `wallet` is the persona's standalone KMD wallet, absent for the external accounts.
        accounts: Object.fromEntries(
          allLabels.map((label) => [
            label,
            {
              address: addr(label),
              mnemonic: accounts.get(label)!.mnemonic,
              wallet: PERSONA_WALLETS[label],
              roles: rolesOf(label),
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  )

  /** What each persona is for, in one line — the point of connecting as it. */
  const personaNotes: Record<string, string> = {
    deployer: 'admin + operator — unlocks the Manage UI',
    alice: 'gov · delegatee of bob, g2 · AQ in both instances',
    bob: "gov · delegated to alice · the delegator's view",
    carol: 'AQ only, no gGov voting power',
  }

  // Rows print into a fixed label gutter, so how this source is indented no longer decides how the
  // output lines up — which is exactly what one long template literal cannot give you.
  const out: string[] = []
  const section = (label: string, ...rows: string[]) => {
    rows.forEach((row, i) => out.push((i === 0 ? label : '').padEnd(13) + row))
    out.push('')
  }

  const escrowShare = Math.round((escrowVotes / committeeFile.totalVotes) * 100)

  section(
    'REGISTRIES',
    `gGov  ${gGovRegistryApp.appId}  ${gGovRegistryApp.appAddress}`,
    `frac  ${fracRegistryApp.appId}  ${fracRegistryApp.appAddress}`,
    'deployer is admin + operator of both',
  )
  section(
    'COMMITTEE',
    `0x${hex(committeeId).slice(0, 16)}…`,
    `${committeeFile.totalMembers} members · ${num(committeeFile.totalVotes)} votes · rounds ${num(COMMITTEE_PERIOD_START)}–${num(COMMITTEE_PERIOD_END)}`,
    `${escrowLabels.length} protocol escrows hold ${num(escrowVotes)} of those votes (${escrowShare}%)`,
  )
  section(
    'INSTANCES',
    ...INSTANCES.map(
      (i) =>
        `#${instanceNumIds.get(i.label)} ${i.label.padEnd(8)} app ${instanceAppIds.get(i.label)}  ` +
        `escrows ${i.escrows.join(',').padEnd(6)}  ${num(Object.values(i.aq).reduce((a, b) => a + b, 0))} AQ ` +
        `over ${Object.keys(i.aq).length} accounts`,
    ),
  )
  section(
    'PERIODS',
    `#${endedPeriodId} ENDED     council election · ${ENDED_BALLOTS.length} direct ballots · ${ENDED_FRAC_BALLOTS.length} frac votes`,
    `#${activePeriodId} ACTIVE    council election · ${ACTIVE_BALLOTS.length} direct · ${ACTIVE_FRAC_BALLOTS.length} frac · bob and carol still to vote`,
    `#${upcomingPeriodId} UPCOMING  standard vote · 2 topics · opens in 14 days`,
  )
  section(
    'WALLETS',
    'all four share unencrypted-default-wallet — connect once, switch accounts in the app,',
    'or set VITE_KMD_WALLET=<wallet> for a single-account view',
    ...PERSONAS.map(
      (label) =>
        `${label.padEnd(9)} ${short(addr(label))}  ${PERSONA_WALLETS[label].padEnd(14)} ${personaNotes[label]}`,
    ),
  )
  section(
    'FILES',
    `${'.env'.padEnd(21)}${
      envWritten
        ? `VITE_GGOV_REGISTRY_APP_ID=${gGovRegistryApp.appId} · VITE_FRAC_REGISTRY_APP_ID=${fracRegistryApp.appId}`
        : `missing — set both app IDs by hand (printed at step 4)`
    }`,
    `${path.basename(manifestPath).padEnd(21)}${allLabels.length} addresses + mnemonics, identical on every run`,
  )

  const rule = '═'.repeat(Math.max(...out.map((line) => line.length)))
  console.log(`\n${rule}\nLOCALNET SEED\n${rule}\n`)
  console.log(out.join('\n'))
  console.log('Ready — seed data details on projects/ggov-frontend/.localnet-seed.json. \n')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
