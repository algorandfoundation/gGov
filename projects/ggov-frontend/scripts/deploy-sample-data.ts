/**
 * Seed a localnet with a full gGov session *and* the Fractional Delegation subsystem wired on top,
 * so the frontend has both voting paths populated: direct/delegated gGov ballots, and AQ-weighted
 * internal votes re-cast into gGov through protocol escrows.
 *
 * USAGE
 *   From root:
 *     pnpm --filter "ggov-frontend" seed-localnet-data
 *
 *   Usage from ggov-frontend:
 *     pnpm seed-localnet-data
 *
 *   Leave period 2 as an editable draft instead of a voted one, to work on it from the Manage UI:
 *     SEED_DRAFT_PERIOD=true pnpm seed-localnet-data
 *
 * REQUIREMENTS
 *   Algokit localnet running, both SDKs built (`algokit project run build` builds all projects).
 *
 * PERSONAS (KMD)
 *   The frontend treats every account in the connected wallet as a voter, so the four personas live
 *   together in `unencrypted-default-wallet` (the rich multi-account view) *and* each gets its own
 *   single-account wallet for looking at one persona in isolation:
 *
 *     deployer  admin + operator of both registries; not a gov                        (ggov-deployer)
 *     alice     gov · delegatee of bob and g2 · holds AQ in both instances            (ggov-alice)
 *     bob       gov · holds AQ in Tinyman · delegated his power to alice              (ggov-bob)
 *     carol     AlgoQuarters only, not a committee member                             (ggov-carol)
 *
 *   Between them they cover every governance stance: runs the show, votes and is voted for, hands
 *   its power to someone else, and holds pooled stake with no gGov power of its own.
 *
 *   Switch persona with VITE_KMD_WALLET=ggov-bob and restart vite, or import the persona's
 *   mnemonic (written to the accounts manifest) into any localnet wallet.
 *
 * STEPS
 * 1) RESET & ACCOUNTS
 *   Reset localnet. Derive every account deterministically from a fixed namespace, so addresses are
 *   stable across runs and their mnemonics can be imported into a wallet in case it's needed. Shape
 *   the KMD wallets (see PERSONAS below).
 *
 * 2) REGISTRIES
 *   Deploy the gGov registry and the frac registry, wired to each other in both directions.
 *   The deployer is admin + operator of both. Write both app ids to .env straight away, so vite can
 *   be pointed at the seed while the rest of it is still running.
 *
 * 3) FUNDING
 *   Dispenser → personas, govs, escrows and AlgoQuarter holders.
 *
 * 4) COMMITTEE
 *   Build and upload the committee file. Members are the two gov personas, 13 plain govs, and the
 *   three protocol escrows — escrows hold gGov voting power like any other member, they just never
 *   vote with it themselves.
 *
 * 5) INSTANCES & AQ
 *   Create the `Tinyman tALGO` (1 escrow) and `Réti #42` (2 escrows) instances, register their
 *   escrows, upload an AlgoQuarters manifest to each, then point every escrow's delegation at
 *   its instance app via `importFracDelegations`.
 *
 * 6)  DELEGATIONS
 *   Account-level delegations — one registry map serves both voting paths. Runs after the ingest
 *   above, since a delegator with no committee voting power is only registered by it.
 *
 * 7) PERIOD 1 (ENDED)
 *   A council election voted in full through both paths, inside a short window we then wait out so it
 *   reads as ended.
 *
 * 8) PERIOD 2 (ACTIVE)
 *   Two elections on one shared ballot — one committee, one window, one vote() — each with its own
 *   candidates, seats and ranking. Deliberately half-voted so there is live work left from the UI,
 *   or left unready and unvoted under SEED_DRAFT_PERIOD=true so Manage can still edit it.
 *
 * 9) PERIOD 3 (UPCOMING)
 *   A standard vote, ready and pre-synced by the instances, no votes yet.
 *
 * 10) OUTPUT
 *   Self-check the on-chain result, write the accounts manifest, print the summary.
 *
 * CONSTRAINTS
 *   - The first vote of either kind locks a period against setReady(false)/editPeriod, so all
 *     period editing happens before any vote, and period 3 stays unvoted.
 *   - Keep escrows out of the ballot tables, they must never cast a direct gGov vote.
 */

import { createRequire } from 'node:module'
import { randomBytes, createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import type { Election, GGovCommitteeFile } from 'ggov-sdk'
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
// SEED DEFINITION
// =========================================================

/** Namespace for deterministic key derivation. Change it and every address in the seed changes. */
const SEED_NAMESPACE = 'ggov-localnet'

/** Committee window, in rounds. Shared by the committee file and both AlgoQuarters manifests. */
const COMMITTEE_PERIOD_START = 50_000_000
const COMMITTEE_PERIOD_END = 53_000_000

/**
 * Lifetime of period 1's voting window, in seconds: long enough to cast its ballots inside, short
 * enough that waiting for it to lapse is cheap (see step 7). Overrunning it fails loudly.
 */
const ENDED_VOTING_WINDOW_SECONDS = 40

/**
 * How period 2 is left. By default it casts its ballots, which locks the period; this stops
 * before `setReady` instead, so it stays editable.
 */
const DRAFT_ACTIVE_PERIOD = process.env.SEED_DRAFT_PERIOD === 'true'

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
  x1: 1600, // Tinyman tALGO escrow
  x2: 900, // Réti #42 pool
  x3: 500, // Réti #42 pool
}

/**
 * The two frac instances. The implied AQ-per-vote differs between these two, as it would on reality.
 *
 * Note the deliberate overlap with the committee: bob/g1/g2/g4 hold tALGO and g5 stakes in a Réti pool,
 * so the gov and AQ-holder sets intersect without being the same set. u1..u10 are pure staking
 * protocol users with no gGov voting power of their own.
 */
const INSTANCES = [
  {
    label: 'Tinyman tALGO',
    escrows: ['x1'],
    aq: {
      alice: 118_420,
      bob: 73_180,
      carol: 84_115,
      g1: 236_780,
      g2: 97_650,
      g4: 61_240,
      u1: 305_910,
      u2: 142_300,
      u3: 93_475,
      u4: 258_060,
      u5: 171_890,
      u6: 108_530,
    } as Record<string, number>,
  },
  {
    label: 'Réti #42',
    escrows: ['x2', 'x3'],
    aq: {
      alice: 88_650,
      carol: 127_310,
      g5: 39_425,
      u1: 206_140,
      u2: 73_580,
      u4: 161_290,
      u6: 117_845,
      u7: 274_600,
      u8: 92_130,
      u9: 112_470,
      u10: 78_255,
    } as Record<string, number>,
  },
]

/**
 * Account-level delegations: delegator → delegatee. One map covers both voting paths, so bob hands
 * alice his committee power *and* his Tinyman position in a single delegation.
 */
const DELEGATIONS: [string, string][] = [
  ['bob', 'alice'], // alice casts bob's ballot, and his pooled one
  ['g2', 'alice'], // g2 delegates but will vote directly
]

/**
 * ALGO handed out per account class. Easy to setup and try different scenarios if needed.
 * Escrows do not need funding on this setup.
 *
 * TODO: once instance MBR on-demand is implemented, this can be set to 0. For now, instances
 * need explicit funding for per-period vote caches and every voter's record.
 *
 * TODO: same applies for period when the upfront payment for estimated voting MBR is implemented.
 */
const FUNDING = { deployer: 300, persona: 20, gov: 5, user: 5, instance: 10, period: 5 }

/**
 * A gGov ballot, one character per topic: Y = first option, N = second, A = last (abstain).
 * A `|` marks a race boundary and is ignored — it only keeps a multi-election ballot readable.
 * `castBy` names the delegatee signing on the voter's behalf; absent means the voter signs itself.
 */
type Ballot = { voter: string; ballot: string; castBy?: string }

/** An internal frac vote: same shorthand, weighted by the voter's AlgoQuarters in that instance. */
type FracBallot = { voter: string; ballot: string; instance: string }

/**
 * Period 1's council candidates. Each is a Support/Veto/Abstain ballot; candidates rank by net
 * score (Support − Veto) for the available seats. One race, so none needs an `e` tag.
 */
const ENDED_ELECTIONS: Election[] = [{ t: 'xGov Council', s: 3 }]
const ENDED_CANDIDATE_TOPICS = [
  { title: 'txnlab.algo', body: 'AlgoKit core maintainer and developer tooling.' },
  { title: 'folks.algo', body: 'Folks Finance lending protocol contributor.' },
  { title: 'nodely.algo', body: 'Infrastructure, indexer and node operator.' },
  { title: 'reti.algo', body: 'Reti staking pool collective.' },
  { title: 'gard.algo', body: 'GARD stablecoin protocol team.' },
]

/**
 * Period 2 runs both of these races on one shared ballot — one committee, one window, one vote().
 * Append-only: `e` is an index into this list, so reordering it silently re-tags every candidate.
 */
const ACTIVE_ELECTIONS: Election[] = [
  { t: 'xGov Council', s: 3 },
  { t: 'EAC', s: 1 },
]

/** Period 2's candidates, each naming its race: 4 contest the council's 3 seats, 3 the EAC's one. */
const ACTIVE_CANDIDATE_TOPICS = [
  { title: 'txnlab.algo', body: 'AlgoKit core maintainer and developer tooling.', e: 0 },
  { title: 'folks.algo', body: 'Folks Finance lending protocol contributor.', e: 0 },
  { title: 'nodely.algo', body: 'Infrastructure, indexer and node operator.', e: 0 },
  { title: 'reti.algo', body: 'Reti staking pool collective.', e: 0 },
  { title: 'gard.algo', body: 'GARD stablecoin protocol team.', e: 1 },
  { title: 'pact.algo', body: 'Pact AMM protocol and treasury tooling.', e: 1 },
  { title: 'tinyman.algo', body: 'Tinyman AMM liquidity and grants steward.', e: 1 },
]

/** Period 3's topics. A standard vote, not an election, so they carry no `e` tag and no candidates. */
const UPCOMING_TOPICS = [
  { title: 'Protocol Upgrade v2.0', body: 'Approve deployment of Protocol v2.0 (state proofs, block pipelining).' },
  {
    title: 'Ecosystem Development Fund',
    body: 'Allocate 1M ALGO to an ecosystem development fund for grants and tooling.',
  },
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

/** Period 1 frac votes: a bit under 40% of each pool's AQ turns out; the rest abstains. */
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
 * to cast his ballot for him, or as bob to override by voting directly. Council left of the `|`,
 * EAC right of it; each race ends with one candidate well below its own cutoff.
 */
const ACTIVE_BALLOTS: Ballot[] = [
  { voter: 'alice', ballot: 'YYYN|YYN' },
  { voter: 'g1', ballot: 'YYYN|YYN' },
  { voter: 'g2', ballot: 'YYAN|AYN' },
  { voter: 'g4', ballot: 'YYNA|YYA' },
  { voter: 'g6', ballot: 'YANN|NYN' },
  { voter: 'g8', ballot: 'YNYN|YAY' },
  { voter: 'g9', ballot: 'YYNA|YNY' },
]

/** Period 2 frac votes: Tinyman has started, Réti has not — carol's Réti position is yours to cast. */
const ACTIVE_FRAC_BALLOTS: FracBallot[] = [
  { instance: 'Tinyman tALGO', voter: 'alice', ballot: 'YYYN|YYN' },
  { instance: 'Tinyman tALGO', voter: 'u1', ballot: 'YYNA|YYN' },
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

/** A period's races for the summary: `xGov Council 3 seats/4 cands · EAC 1 seat/3 cands`. */
const races = (elections: Election[], candidates: { title: string; e?: number }[]) =>
  elections
    .map(
      (e, i) => `${e.t} ${e.s} seat${e.s === 1 ? '' : 's'}/${candidates.filter((c) => (c.e ?? 0) === i).length} cands`,
    )
    .join(' · ')

let stepNumber = 0
/** The only progress output inside the pipeline: one line per step, because the run takes minutes. */
const step = (label: string) => console.log(`[${String(++stepNumber).padStart(2, ' ')}/10] ${label}`)

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

/** Rewrite each var in place, or append it when absent. False when there is no .env to write. */
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
  // 2. REGISTRIES
  // =========================================================

  step('Deploying registries…')

  // Funding just the deployer, the rest of the accounts are funded in step 3: an app's id is the
  // ledger's transaction counter at creation, so this lands the registries on the same ids
  // `algokit project deploy` gives them, keeping the .env app ids valid under either approach.
  await algorand.send.payment({ sender: dispenser.addr, receiver: deployer, amount: algo(FUNDING.deployer) })

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

  // The two app ids are all the frontend needs, so write .env here: vite can be pointed at the deployed registries
  // while the slow data work below is still running.
  const envPath = path.resolve(__dirname, '../.env')
  const envWritten = setEnvVars(envPath, {
    VITE_GGOV_REGISTRY_APP_ID: gGovRegistryApp.appId,
    VITE_FRAC_REGISTRY_APP_ID: fracRegistryApp.appId,
  })
  console.log(
    envWritten
      ? `        wrote .env → gGov ${gGovRegistryApp.appId} · frac ${fracRegistryApp.appId} — start vite whenever, the seed keeps running`
      : `        no .env found — set VITE_GGOV_REGISTRY_APP_ID=${gGovRegistryApp.appId} and VITE_FRAC_REGISTRY_APP_ID=${fracRegistryApp.appId} by hand`,
  )

  // =========================================================
  // 3. FUNDING
  // =========================================================

  step('Funding accounts…')

  const fundingPlan: { label: string; algos: number }[] = [
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
  // 4. GGOV COMMITTEE
  // =========================================================

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
  // 5. INSTANCES & ALGOQUARTERS
  // =========================================================

  step('Creating frac-delegation instances and uploading AQ files…')

  const instanceNumIds = new Map<string, bigint>()
  const instanceAppIds = new Map<string, bigint>()

  for (const instance of INSTANCES) {
    // Only 1 ALGO for MBR payment, as will use `uploadAqFile`'s `autoFund` feature.
    const instanceNumId = await fracSdk.registry.addInstance({ name: instance.label, mbrAmount: 1e6 })
    const appId = await fracSdk.getInstanceAppId(instanceNumId)
    instanceNumIds.set(instance.label, instanceNumId)
    instanceAppIds.set(instance.label, appId)

    for (const escrow of instance.escrows) {
      await fracSdk.registry.registerEscrow({ instanceNumId, account: addr(escrow) })
    }

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
    await fracSdk.uploadAqFile({ instanceNumId, committeeId, aqFile, autoFund: true })

    // TODO: remove once instance on-demand MBR is implemented. See `FUNDING` for more details.
    await algorand.send.payment({
      sender: deployer,
      receiver: algosdk.getApplicationAddress(appId).toString(),
      amount: algo(FUNDING.instance),
      note: randomNote(),
    })
  }

  // Point every escrow's delegation at the instance it belongs to.
  await sdk.registry.importFracDelegationsAll({ escrowAccounts: escrowLabels.map(addr) })

  // =========================================================
  // 6. DELEGATIONS
  // =========================================================

  step('Setting delegations…')

  for (const [delegator, delegatee] of DELEGATIONS) {
    await voterSdk(delegator).registry.setVotingAccount({
      votingAddress: addr(delegatee),
      // Without committee power the registry misses its accounts box and resolves through a frac
      // registry inner call, whose fee the group pays up front.
      fractionalOnly: GOV_VOTES[delegator] === undefined,
    })
  }

  // =========================================================
  // PERIOD HELPERS
  // =========================================================

  const now = BigInt(Math.floor(Date.now() / 1000))

  /**
   * Create a period end to end: open a future window first (so topics can be added), upload the body
   * — with `elect`, one entry per election, for an election period — add the topics, set the real
   * window, mark it ready, fund its vote-record boxes, and sync it on both frac-delegation instances.
   *
   * `draft` leaves the period editable: `setReady` is what freezes the topic set, and `syncPeriod`
   * refuses an unready period (ERR:GP_NOTREADY) precisely because a snapshot taken while topics
   * can still change would cache a shape that then drifts out from under it.
   */
  async function createPeriodHelper(opts: {
    title: string
    body: string
    elect?: Election[]
    topics: { title: string; body: string; options?: string[]; e?: number }[]
    votingStart: bigint
    votingEnd: bigint
    draft?: boolean
  }): Promise<bigint> {
    const periodId = (await sdk.registry.addPeriod({
      committeeId,
      votingStart: now + 100000n,
      votingEnd: now + 200000n,
    })) as bigint
    await sdk.uploadPeriodBody({
      periodId,
      body: {
        title: opts.title,
        body: opts.body,
        ...(opts.elect !== undefined ? { elect: opts.elect } : {}),
      },
    })
    for (const topic of opts.topics) {
      // addTopicWithBody packs addTopic + the body chunks into one atomic, single-signature group.
      // Election candidates are always Support/Veto/Abstain (mirroring the Manage UI); standard
      // topics use their own options. Either way Abstain is last, as frac voting requires.
      await sdk.addTopicWithBody({
        periodId,
        options:
          opts.elect !== undefined ? ['Support', 'Veto', 'Abstain'] : (topic.options ?? ['Yes', 'No', 'Abstain']),
        // A candidate joins one race by its index into `elect`. Tagging is mandatory — an untagged
        // one is an authoring error, not election 0 — but a single-race period needn't say so.
        body: { title: topic.title, body: topic.body, ...(opts.elect !== undefined ? { e: topic.e ?? 0 } : {}) },
        note: randomNote(),
      })
    }
    await sdk.editPeriod({ periodId, committeeId, votingStart: opts.votingStart, votingEnd: opts.votingEnd })
    if (!opts.draft) await sdk.setReady({ periodId, ready: true })

    // The period app pays MBR for one vote-record box per voter, so needs funding.
    // TODO: this extra payment won't be needed in the future. See `FUNDING`.
    const periodAppId = await sdk.getPeriodAppId(periodId)
    await algorand.send.payment({
      sender: deployer,
      receiver: algosdk.getApplicationAddress(periodAppId).toString(),
      amount: algo(FUNDING.period),
      note: randomNote(),
    })

    // Snapshot the now-ready period on both instances. Without this an instance's vote() has nothing to write into (ERR:GP_NX).
    if (!opts.draft) {
      for (const instance of INSTANCES) {
        await fracSdk.syncPeriod({ instanceNumId: instanceNumIds.get(instance.label)!, periodApp: periodAppId })
      }
    }
    return periodId
  }

  /** One-hot row: the voter's full weight on the chosen option. Y → first, N → second, A → last. */
  const oneHot = (choice: string, weight: number, options: number) => {
    const index = choice === 'Y' ? 0 : choice === 'N' ? 1 : options - 1
    return Array.from({ length: options }, (_, i) => (i === index ? weight : 0))
  }

  /** One choice per topic, dropping the `|` race separators a multi-election ballot is written with. */
  const choices = (ballot: string) => ballot.replace(/\|/g, '').split('')

  /** Cast gGov ballots with each voter's committee voting power, signed by the voter or its delegatee. */
  async function castBallots(periodId: bigint, ballots: Ballot[]) {
    for (const { voter, ballot, castBy } of ballots) {
      const topicVotes = choices(ballot).map((c) => oneHot(c, GOV_VOTES[voter], 3))
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
      const topicVotes = choices(ballot).map((c) => oneHot(c, aq, 3))
      await fracVoterSdk(voter).vote({
        instanceNumId: instanceNumIds.get(instance)!,
        periodId,
        topicVotes,
        note: randomNote(),
      })
    }
  }

  // =========================================================
  // 7. PERIOD 1 — ENDED council election
  // =========================================================

  // The contract blocks editPeriod once a period is `ready` (and voting requires ready), and
  // setReady(false) is blocked once votes exist — so a voted period can't be backdated. Instead give
  // it a short window, cast within it, then let wall-clock pass votingEnd; the frontend derives
  // "ended" from votingEnd vs now.
  step('Period 1 — ENDED council election…')

  const endedVotingStart = BigInt(Math.floor(Date.now() / 1000))
  const endedVotingEnd = endedVotingStart + BigInt(ENDED_VOTING_WINDOW_SECONDS)
  const endedPeriodId = await createPeriodHelper({
    title: 'gGov Council — Term 1 election',
    body: 'Elect 3 council members. Each candidate below is a Support/Veto/Abstain ballot; candidates are ranked by net score (Support − Veto) and the top 3 took the available seats.',
    elect: ENDED_ELECTIONS,
    topics: ENDED_CANDIDATE_TOPICS,
    votingStart: endedVotingStart - 3600n,
    votingEnd: endedVotingEnd,
  })
  try {
    await castBallots(endedPeriodId, ENDED_BALLOTS)
    await castFracBallots(endedPeriodId, ENDED_FRAC_BALLOTS)
  } catch (err) {
    if (Math.floor(Date.now() / 1000) < Number(endedVotingEnd)) throw err
    throw Object.assign(
      new Error(
        `Period 1's voting window (${ENDED_VOTING_WINDOW_SECONDS}s) closed before its ballots were cast. ` +
          `Raise ENDED_VOTING_WINDOW_SECONDS. Original error: ${(err as Error).message}`,
      ),
      { cause: err },
    )
  }

  // Wait for the voting window to lapse so the period reads as ENDED in the UI.
  const waitMs = Number(endedVotingEnd) * 1000 + 2000 - Date.now()
  if (waitMs > 0) {
    console.log(`        waiting ${Math.ceil(waitMs / 1000)}s for the voting window to close…`)
    await new Promise((r) => setTimeout(r, waitMs))
  }

  // =========================================================
  // 8. PERIOD 2 — ACTIVE two-election period
  // =========================================================

  step(`Period 2 — ${DRAFT_ACTIVE_PERIOD ? 'DRAFT' : 'ACTIVE'} two-election period…`)

  const activePeriodId = await createPeriodHelper({
    title: 'gGov Council — Term 2 elections',
    body: 'Elect 3 council members and 1 EAC member. Each candidate below is a Support/Veto/Abstain ballot; candidates are ranked by net score (Support − Veto) within their own election, and the top scorers lead for that election’s seats.',
    elect: ACTIVE_ELECTIONS,
    topics: ACTIVE_CANDIDATE_TOPICS,
    votingStart: now - 3600n,
    votingEnd: now + 86400n * 7n,
    draft: DRAFT_ACTIVE_PERIOD,
  })
  if (!DRAFT_ACTIVE_PERIOD) {
    await castBallots(activePeriodId, ACTIVE_BALLOTS)
    await castFracBallots(activePeriodId, ACTIVE_FRAC_BALLOTS)
  }

  // =========================================================
  // 9. PERIOD 3 — UPCOMING standard vote
  // =========================================================

  // Ready and pre-synced by both instances (the realistic operator sequence), but unvoted — the
  // first vote of either kind would lock it against further editing.
  step('Period 3 — UPCOMING standard vote…')

  const upcomingPeriodId = await createPeriodHelper({
    title: 'Q2 2026 Governance',
    body: 'Upcoming governance period covering protocol upgrades and ecosystem strategy.',
    topics: UPCOMING_TOPICS,
    votingStart: now + 86400n * 14n,
    votingEnd: now + 86400n * 28n,
  })

  // =========================================================
  // 10. OUTPUT
  // =========================================================

  step('Verifying and writing output…')

  // gGov demands a voter's full power on every topic, so each topic of period 1 must tally to the
  // direct voters' power plus every escrow's — members who never voted contribute nothing. The
  // escrow half only lands if both instances mapped their internal tallies out to gGov.
  const directVotes = ENDED_BALLOTS.reduce((sum, b) => sum + GOV_VOTES[b.voter], 0)
  const escrowVotes = escrowLabels.reduce((sum, label) => sum + GOV_VOTES[label], 0)
  const endedPeriod = await sdk.getPeriod(endedPeriodId)
  // getPeriod turns a failed read into an empty period rather than throwing, and a period with no
  // topics passes the tally loop below without checking anything. Count them first.
  if (endedPeriod.topics.length !== ENDED_CANDIDATE_TOPICS.length) {
    throw new Error(
      `Period ${endedPeriodId}: read back ${endedPeriod.topics.length} topics, expected ${ENDED_CANDIDATE_TOPICS.length}.`,
    )
  }
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
    bob: "gov + AQ · delegated both to alice · the delegator's view",
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
        `#${instanceNumIds.get(i.label)} ${i.label.padEnd(13)} app ${instanceAppIds.get(i.label)}  ` +
        `escrows ${i.escrows.join(',').padEnd(6)}  ${num(Object.values(i.aq).reduce((a, b) => a + b, 0))} AQ ` +
        `over ${Object.keys(i.aq).length} accounts`,
    ),
  )
  const activeRaces = races(ACTIVE_ELECTIONS, ACTIVE_CANDIDATE_TOPICS)

  section(
    'PERIODS',
    `#${endedPeriodId} ENDED     ${races(ENDED_ELECTIONS, ENDED_CANDIDATE_TOPICS)} · ${ENDED_BALLOTS.length} direct ballots · ${ENDED_FRAC_BALLOTS.length} frac votes`,
    DRAFT_ACTIVE_PERIOD
      ? `#${activePeriodId} DRAFT     ${activeRaces} · unready and unvoted`
      : `#${activePeriodId} ACTIVE    ${activeRaces} · ${ACTIVE_BALLOTS.length} direct · ${ACTIVE_FRAC_BALLOTS.length} frac · bob and carol still to vote`,
    `#${upcomingPeriodId} UPCOMING  standard vote · ${UPCOMING_TOPICS.length} topics · opens in 14 days`,
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
        : `missing — set VITE_GGOV_REGISTRY_APP_ID=${gGovRegistryApp.appId} by hand`
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
