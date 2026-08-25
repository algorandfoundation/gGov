/**
 * Synthetic-account substitution for the mirror seed.
 *
 * A mirror of mainnet on another network carries accounts nobody can sign for there: app escrows,
 * liquidity pools and the Algorand Foundation's own accounts. Each such account is replaced 1:1 by a freshly generated one whose mnemonic
 * we keep, so testers can vote with its exact voting power. The `SubstitutionBook` owns that
 * `real → synthetic` map and persists it after every mutation: the accounts are random, so a resumed
 * run has to reuse them for the committee id and the AQ manifests to reproduce.
 */

import * as fs from 'node:fs'
import * as algosdk from 'algosdk'
import type { GGovCommitteeFile } from 'ggov-sdk'

/** Why a real account cannot sign on the target network. */
export type SubstitutionReason = 'app-escrow' | 'tinyman-pool' | 'foundation'

export type VotingPowerEntry =
  | { kind: 'core'; votes: number; totalVotes: number }
  | { kind: 'frac'; instance: string; source: string; algoQuarters: string; totalAlgoQuarters: string }

export type SyntheticAccount = {
  address: string
  mnemonic: string
  /** The mainnet account this one stands in for. */
  replaces: string
  reason: SubstitutionReason
  /** Owning app, when escreg resolved one. */
  appId?: string
  votingPower: VotingPowerEntry[]
  /** Human-readable summary of `votingPower` and `reason`. */
  note: string
}

export type SyntheticAccountsFile = {
  network: string
  gGovRegistryAppId: number
  fracRegistryAppId: number
  /** Committee id of the rewritten (synthetic) committee, once known. */
  committeeId?: string
  /** Committee id of the untouched mainnet committee file, for reference. */
  realCommitteeId?: string
  generatedAt: string
  accounts: SyntheticAccount[]
}

export type BookIdentity = Pick<SyntheticAccountsFile, 'network' | 'gGovRegistryAppId' | 'fracRegistryAppId'>

const fmt = (n: number | bigint | string) => BigInt(n).toLocaleString('en-US')
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`

/** Signer every Tinyman liquidity pool account is rekeyed to. */
export const TINYMAN_POOL_AUTH_ADDR = 'XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM'

function renderNote(account: Omit<SyntheticAccount, 'note'>): string {
  const power = account.votingPower.map((entry) =>
    entry.kind === 'core'
      ? `Core governor: ${fmt(entry.votes)} of ${fmt(entry.totalVotes)} committee votes`
      : `Frac governor: ${fmt(entry.algoQuarters)} of ${fmt(entry.totalAlgoQuarters)} AlgoQuarters in "${entry.instance}" (${entry.source})`,
  )
  const why =
    account.reason === 'tinyman-pool'
      ? `Tinyman pool, rekeyed to ${short(TINYMAN_POOL_AUTH_ADDR)}`
      : account.reason === 'foundation'
        ? 'Algorand Foundation account'
        : `app escrow${account.appId ? ` of app ${account.appId}` : ''}`
  return `${power.join('. ') || 'No voting power recorded yet'}. Replaces ${account.replaces} (${why}).`
}

export class SubstitutionBook {
  private readonly byReal = new Map<string, SyntheticAccount>()
  private readonly path: string
  private file: SyntheticAccountsFile

  // No parameter properties: `--experimental-strip-types` does not support them (see plugins/base.ts)
  private constructor(path: string, file: SyntheticAccountsFile) {
    this.path = path
    this.file = file
    for (const account of file.accounts) this.byReal.set(account.replaces, account)
  }

  /**
   * Open the book at `path`: an existing file is resumed if it was written for the same network and
   * registries, otherwise the run aborts rather than mixing two seeds' keys.
   */
  static open(path: string, identity: BookIdentity, now: () => Date = () => new Date()): SubstitutionBook {
    if (fs.existsSync(path)) {
      const file = JSON.parse(fs.readFileSync(path, 'utf-8')) as SyntheticAccountsFile
      const same =
        file.network === identity.network &&
        file.gGovRegistryAppId === identity.gGovRegistryAppId &&
        file.fracRegistryAppId === identity.fracRegistryAppId
      if (!same) {
        throw new Error(
          `${path} was written for ${file.network} registries ${file.gGovRegistryAppId}/${file.fracRegistryAppId}, ` +
            `not ${identity.network} ${identity.gGovRegistryAppId}/${identity.fracRegistryAppId} — move it away to start over`,
        )
      }
      return new SubstitutionBook(path, file)
    }
    return new SubstitutionBook(path, { ...identity, generatedAt: now().toISOString(), accounts: [] })
  }

  get size() {
    return this.byReal.size
  }

  get accounts(): readonly SyntheticAccount[] {
    return this.file.accounts
  }

  /** The synthetic stand-in for `real`, if one exists. */
  get(real: string): SyntheticAccount | undefined {
    return this.byReal.get(real)
  }

  /** The synthetic stand-in for `real`, generating (and persisting) one on first sight. */
  getOrCreate(real: string, reason: SubstitutionReason, appId?: bigint): SyntheticAccount {
    const existing = this.byReal.get(real)
    if (existing) return existing
    const generated = algosdk.generateAccount()
    const account: SyntheticAccount = {
      address: generated.addr.toString(),
      mnemonic: algosdk.secretKeyToMnemonic(generated.sk),
      replaces: real,
      reason,
      ...(appId === undefined ? {} : { appId: appId.toString() }),
      votingPower: [],
      note: '',
    }
    account.note = renderNote(account)
    this.byReal.set(real, account)
    this.file.accounts.push(account)
    this.save()
    return account
  }

  /** Record what `real`'s stand-in can vote with. Idempotent for an identical entry (resumed runs). */
  addVotingPower(real: string, entry: VotingPowerEntry): void {
    const account = this.byReal.get(real)
    if (!account) throw new Error(`no synthetic account for ${real}`)
    const key = JSON.stringify(entry)
    if (account.votingPower.some((e) => JSON.stringify(e) === key)) return
    account.votingPower.push(entry)
    account.note = renderNote(account)
    this.save()
  }

  setCommitteeIds(ids: { committeeId: string; realCommitteeId: string }): void {
    this.file = { ...this.file, ...ids }
    this.save()
  }

  /** `real → synthetic address` for every account in the book. */
  addressMap(): Map<string, string> {
    return new Map([...this.byReal].map(([real, { address }]) => [real, address]))
  }

  /** Atomic: written next to the file and renamed over it, so a crash never leaves a half file. */
  save(): void {
    const tmp = `${this.path}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`)
    fs.renameSync(tmp, this.path)
  }
}

/** Codepoint order, the committee-file convention (and what `buildGGovCommitteeFile` uses). */
const byAddress = (a: { address: string }, b: { address: string }) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0

/**
 * The committee with every address in `map` replaced by its stand-in, re-sorted as the uploader
 * would. Votes and totals are untouched, so the synthetic committee weighs exactly like the real one.
 */
export function rewriteCommittee(file: GGovCommitteeFile, map: Map<string, string>): GGovCommitteeFile {
  const govs = file.govs.map((gov) => ({ ...gov, address: map.get(gov.address) ?? gov.address })).sort(byAddress)
  if (new Set(govs.map((g) => g.address)).size !== govs.length) {
    throw new Error('rewriteCommittee: substitution produced a duplicate committee member')
  }
  return { ...file, govs }
}
