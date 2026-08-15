import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { RetiGhostSDK } from 'reti-ghost-sdk'
import { RETI_REGISTRY_APP_ID, TALGO_APP_ID } from '../src/pipeline.ts'

// CJS copy for everything touching the local SDKs, rooted at the ggov-sdk dist.
// See `algorand2` in FracPipelineArgs for why the realms have to stay apart.
const require = createRequire(fileURLToPath(new URL('../../ggov-sdk/dist/index.js', import.meta.url)))
const { AlgorandClient: CjsAlgorandClient, Config } = require('@algorandfoundation/algokit-utils') as {
  AlgorandClient: typeof AlgorandClient
  Config: { configure: (c: Record<string, unknown>) => void }
}
export { CjsAlgorandClient }
export const algosdk = require('algosdk') as typeof import('algosdk')

export const configLogger = () =>
  Config.configure({
    logger: { error: console.error, warn: console.warn, info: () => {}, verbose: () => {}, debug: () => {} },
  })

// =========================================================
// SEED DEFINITION SHARED BY BOTH COMMITTEES
// =========================================================

const SEED_NAMESPACE = 'frac-pipeline-localnet'
export const COMMITTEE_PERIOD_START = 60_000_000
export const COMMITTEE_PERIOD_END = 63_000_000

/** Generated committee members: label → voting power. None of them vote in these seeds. */
export const GOV_VOTES: Record<string, number> = {
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
export const ESCROW_VOTES = 900

// =========================================================
// ACCOUNTS
// =========================================================

export type SeedAccount = { label: string; address: string; mnemonic: string }

export function deterministicAccount(label: string): SeedAccount {
  const seed = new Uint8Array(createHash('sha512-256').update(`${SEED_NAMESPACE}:${label}`).digest())
  const mnemonic = algosdk.mnemonicFromSeed(seed)
  return { label, address: algosdk.mnemonicToSecretKey(mnemonic).addr.toString(), mnemonic }
}

// =========================================================
// REAL MAINNET ESCROWS
// =========================================================

export type Escrow = { instance: string; address: string; source: 'reti' | 'talgo' }

/**
 * Read the escrows named in `spec` off mainnet — `reti` validator ids, whose pools are escrows, and
 * tALGO `account_N` slots.
 */
export async function fetchEscrows(
  mainnet: AlgorandClient,
  spec: { reti: number[]; talgo: number[] },
): Promise<Escrow[]> {
  const retiSdk = new RetiGhostSDK({ algorand: mainnet, registryAppId: RETI_REGISTRY_APP_ID })
  const pools = await retiSdk.getPools(spec.reti)

  const reti: Escrow[] = spec.reti.flatMap((validatorId, i) =>
    pools[i].map((p) => ({
      instance: `Reti #${validatorId}`,
      address: algosdk.getApplicationAddress(p.poolAppId).toString(),
      source: 'reti' as const,
    })),
  )

  const state = await mainnet.app.getGlobalState(TALGO_APP_ID)
  const talgo: Escrow[] = spec.talgo.map((slot) => {
    const entry = state[`account_${slot}`]
    if (!entry || !('valueRaw' in entry)) throw new Error(`talgo: app ${TALGO_APP_ID} has no account_${slot}`)
    return { instance: 'Tinyman tALGO', address: algosdk.encodeAddress(entry.valueRaw), source: 'talgo' as const }
  })

  const escrows = [...reti, ...talgo]
  // A repeat here would surface far downstream as the pipeline's `Repeated escrows found across sources`.
  if (new Set(escrows.map((e) => e.address)).size !== escrows.length) {
    throw new Error('escrow spec produced a repeated address')
  }
  return escrows
}

/** In first-seen order. */
export const instanceNames = (escrows: Escrow[]) => [...new Set(escrows.map((e) => e.instance))]

export const byInstance = (escrows: Escrow[]) =>
  instanceNames(escrows).map((name) => ({
    name,
    escrows: escrows.filter((e) => e.instance === name).map((e) => e.address),
  }))

// =========================================================
// SEED FILE
// =========================================================

export type SeedFile = {
  gGovRegistryAppId: number
  fracRegistryAppId: number
  /** The committee the pipeline should run against. `add-committee` overwrites both of these. */
  committeeId: string
  expectedInstances: { name: string; escrows: string[] }[]
  accounts: Record<string, { address: string; mnemonic: string }>
}

const seedFilePath = () => fileURLToPath(new URL('../.localnet-seed.json', import.meta.url))

export function readSeedFile(): SeedFile {
  const path = seedFilePath()
  if (!fs.existsSync(path)) throw new Error('No .localnet-seed.json — run `pnpm seed-localnet` first')
  return JSON.parse(fs.readFileSync(path, 'utf-8')) as SeedFile
}

export const writeSeedFile = (seed: SeedFile) => fs.writeFileSync(seedFilePath(), `${JSON.stringify(seed, null, 2)}\n`)

// =========================================================
// OUTPUT
// =========================================================

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
export const num = (n: number) => n.toLocaleString('en-US')

/** Gutter is sized by the widest label, so a long one can never run into its own first row. */
export function printSections(title: string, sections: { label: string; rows: string[] }[]) {
  const gutter = Math.max(...sections.map((s) => s.label.length)) + 2
  const out = sections.flatMap(({ label, rows }) => [
    ...rows.map((row, i) => (i === 0 ? label : '').padEnd(gutter) + row),
    '',
  ])
  const rule = '═'.repeat(Math.max(...out.map((line) => line.length)))
  console.log(`\n${rule}\n${title}\n${rule}\n`)
  console.log(out.join('\n'))
}
