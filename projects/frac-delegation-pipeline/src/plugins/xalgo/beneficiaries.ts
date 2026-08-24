/**
 * Who a holder stands for: a Folks escrow (→ its owner) or itself.
 *
 * Escrows are fresh accounts rekeyed to a Folks app (loan, deposits, deposit staking), holding the
 * user's fxALGO as collateral or deposit. The owner is in the escrow's local state (`u` / `ua`) while
 * it is open, and that state disappears when the escrow closes — but the Indexer still reports the
 * closed local state's app id and `opted-in-at-round`, and the creation group contains a payment
 * from the owner to the app address with note `prefix + escrow pubkey` in that very round. Both are
 * immutable facts, so every resolution is cached and never recomputed.
 *
 * Candidate-driven on purpose: only addresses that actually hold or receive xALGO or fxALGO in the
 * window are resolved (~10k, ~0.1 s each, and only once) — both assets, because the attribution
 * credits an escrow's direct xALGO to its owner too. The bulk alternative — note-prefix scans of all
 * escrow creations — times out on the GENERAL loan app even in 1M-round windows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { type Indexer, type indexerModels, decodeAddress, encodeAddress } from 'algosdk'
import pMap from 'p-map'

import { stringifyJson, withRetry } from '../../aq/index.ts'
import {
  ESCROW_NOTE_LENGTH,
  FOLKS_ESCROW_APP_BY_ID,
  FOLKS_UNTRACKED_LOAN_APPS,
  XALGO_POOL_ADDRESS,
  type FolksEscrowApp,
} from './constants.ts'
import type { Beneficiary, BeneficiaryFile, BeneficiaryMap } from './types.ts'

/** TEAL value type tag for bytes, as the Indexer reports it. */
const TEAL_BYTES = 1

/** The owner an open escrow's local state names, or undefined when the state is closed or has no owner key. */
export function ownerFromLocalState(
  state: indexerModels.ApplicationLocalState,
  app: FolksEscrowApp,
): string | undefined {
  if (state.deleted) return undefined
  const ownerKey = new TextEncoder().encode(app.ownerKey)
  for (const { key, value } of state.keyValue ?? []) {
    if (key.length !== ownerKey.length || !ownerKey.every((byte, i) => key[i] === byte)) continue
    if (value.type !== TEAL_BYTES || value.bytes.length !== 32) return undefined
    return encodeAddress(value.bytes)
  }
  return undefined
}

/** The creation note an escrow's owner sent to the app: `prefix + 32-byte escrow pubkey`. */
export function escrowCreationNote(escrow: string, app: FolksEscrowApp): Uint8Array {
  const note = new Uint8Array(ESCROW_NOTE_LENGTH)
  note.set(app.notePrefix, 0)
  note.set(decodeAddress(escrow).publicKey, app.notePrefix.length)
  return note
}

function* payments(txn: indexerModels.Transaction): Generator<indexerModels.Transaction> {
  if (txn.paymentTransaction) yield txn
  for (const inner of txn.innerTxns ?? []) yield* payments(inner)
}

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte)

/**
 * The owner of a closed escrow, from the creation payment in its opt-in round: a `pay` to the app
 * address whose note is the escrow's creation note, from the owner. The Indexer answers a
 * note-prefix query in a single round instantly, and returns the root transaction when the payment
 * is an inner one (an integrator contract creating the escrow), hence the walk.
 * @throws when no such payment is found, or several senders claim the escrow
 */
export async function fetchCreationOwner(
  indexer: Indexer,
  escrow: string,
  app: FolksEscrowApp,
  optInRound: bigint,
): Promise<string> {
  const note = escrowCreationNote(escrow, app)
  const data = await withRetry(() =>
    indexer.searchForTransactions().minRound(optInRound).maxRound(optInRound).txType('pay').notePrefix(note).do(),
  )
  const senders = new Set<string>()
  for (const root of data.transactions ?? []) {
    for (const txn of payments(root)) {
      if (txn.paymentTransaction?.receiver !== app.address) continue
      if (!txn.note || !startsWith(txn.note, note)) continue
      senders.add(txn.sender)
    }
  }
  if (senders.size === 1) return [...senders][0]
  throw new Error(
    senders.size === 0
      ? `xalgo: closed escrow ${escrow} of ${app.label}: no creation note payment found in round ${optInRound} — created outside the note convention?`
      : `xalgo: closed escrow ${escrow} of ${app.label}: ${senders.size} senders sent its creation note in round ${optInRound}: ${[...senders].join(', ')}`,
  )
}

/** One address's resolution, plus what the chain says about its custody — for the escrow-factory check. */
export interface Resolution {
  beneficiary: Beneficiary
  /** The account's `auth-addr`, when it is rekeyed. */
  authAddr?: string
  /** Apps the account holds (or held) local state in. */
  localStateApps: bigint[]
}

/**
 * Resolve one fxALGO-holding address: a Folks escrow (open or closed) to its owner, anything else
 * to itself.
 */
export async function resolveBeneficiary(indexer: Indexer, address: string): Promise<Resolution> {
  // `includeAll` keeps closed-out local states (with their opt-in round) in the answer; `exclude`
  // drops the resources this never reads — without it the Indexer refuses accounts holding more than
  // ~1000 assets/apps with "Result limit exceeded", and some fxALGO holders are exactly that kind of whale
  const { account } = await withRetry(() =>
    indexer.lookupAccountByID(address).includeAll(true).exclude('assets,created-assets,created-apps').do(),
  )
  const localStates = account.appsLocalState ?? []
  const custody = { authAddr: account.authAddr?.toString(), localStateApps: localStates.map((state) => state.id) }

  const escrowStates = localStates.flatMap((state) => {
    const app = FOLKS_ESCROW_APP_BY_ID.get(state.id)
    return app ? [{ app, state }] : []
  })
  if (escrowStates.length > 1) {
    const labels = escrowStates.map(({ app }) => app.label).join(', ')
    throw new Error(
      `xalgo: ${address} has local state in ${escrowStates.length} Folks escrow apps (${labels}) — not a single-app escrow`,
    )
  }
  if (escrowStates.length === 1) {
    const { app, state } = escrowStates[0]
    if (state.optedInAtRound === undefined) {
      throw new Error(`xalgo: escrow ${address} of ${app.label} has no opted-in round on the Indexer`)
    }
    const owner =
      ownerFromLocalState(state, app) ?? (await fetchCreationOwner(indexer, address, app, state.optedInAtRound))
    return {
      beneficiary: { kind: 'escrow', owner, app: Number(app.appId), optInRound: Number(state.optedInAtRound) },
      ...custody,
    }
  }
  return { beneficiary: { kind: 'self' }, ...custody }
}

/** A plain (`self`) holder's custody facts, as `escrowLikeWarnings` wants them. */
export interface SelfHolderCustody {
  address: string
  authAddr?: string
  localStateApps: bigint[]
}

/**
 * What an escrow factory this plugin does not see through looks like: several fxALGO holders
 * rekeyed to the *same* address (each Folks app rekeys every escrow to its own account), or any
 * holder rekeyed to one of Folks' other loan apps. A user rekeying a wallet to a cold key is 1:1 and
 * stays quiet. Returns one warning per finding, for the caller to log.
 */
export function escrowLikeWarnings(holders: Iterable<SelfHolderCustody>): string[] {
  const byAuthAddr = new Map<string, SelfHolderCustody[]>()
  for (const holder of holders) {
    if (!holder.authAddr) continue
    const group = byAuthAddr.get(holder.authAddr) ?? []
    group.push(holder)
    byAuthAddr.set(holder.authAddr, group)
  }
  const warnings: string[] = []
  for (const [authAddr, group] of [...byAuthAddr].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const folksLoanApp = FOLKS_UNTRACKED_LOAN_APPS.get(authAddr)
    if (!folksLoanApp && group.length < 2) continue
    const commonApps = group
      .map((holder) => new Set(holder.localStateApps.map(String)))
      .reduce((common, apps) => new Set([...common].filter((app) => apps.has(app))))
    const examples = group
      .map((holder) => holder.address)
      .sort()
      .slice(0, 3)
      .join(', ')
    warnings.push(
      folksLoanApp
        ? `${group.length} fxALGO holder(s) rekeyed to Folks ${folksLoanApp} — that loan type now takes xALGO collateral: add it to FOLKS_ESCROW_APPS (e.g. ${examples})`
        : `${group.length} fxALGO holders rekeyed to ${authAddr}${commonApps.size ? `, all with local state in app(s) ${[...commonApps].join(', ')}` : ''} — an escrow factory this plugin does not see through, credited to the escrows themselves (e.g. ${examples})`,
    )
  }
  return warnings
}

/**
 * Resolve every candidate not yet in `cache` (the pool excepted), adding the results to it.
 * Candidates are what `collectBeneficiaryCandidates` produces: the addresses holding *either* xALGO
 * or fxALGO at the window start, plus every receiver of either inside it — direct xALGO folds
 * through this map exactly like pool share, so an escrow holding only bare xALGO must resolve too.
 * Returns the addresses added and the escrow-factory warnings among them, for the caller to log and
 * persist.
 */
export async function resolveBeneficiaries(
  indexer: Indexer,
  candidates: Iterable<string>,
  cache: BeneficiaryMap,
  concurrency = 4,
): Promise<{ added: string[]; warnings: string[] }> {
  const pending = [...new Set(candidates)].filter((address) => address !== XALGO_POOL_ADDRESS && !cache.has(address))
  const resolved = await pMap(
    pending,
    async (address) => ({ address, ...(await resolveBeneficiary(indexer, address)) }),
    { concurrency },
  )
  for (const { address, beneficiary } of resolved) cache.set(address, beneficiary)
  const warnings = escrowLikeWarnings(resolved.filter((r) => r.beneficiary.kind === 'self'))
  return { added: pending, warnings }
}

/** The address credited for `address`'s holdings: its escrow owner, or itself. */
export function beneficiaryOf(map: BeneficiaryMap, address: string): string {
  const entry = map.get(address)
  return entry?.kind === 'escrow' ? entry.owner : address
}

function withoutAddress(entry: BeneficiaryFile['entries'][number]): Beneficiary {
  return entry.kind === 'escrow'
    ? { kind: 'escrow', owner: entry.owner, app: entry.app, optInRound: entry.optInRound }
    : { kind: 'self' }
}

/**
 * File persistence for the resolution cache, `<snapshotsDir>/beneficiaries.json`. Entries are
 * sorted by address so the committed file diffs as pure insertions. `createSnapshotFiles` only
 * treats `<digits>.json` as snapshots, so the file lives safely next to them.
 */
export function createBeneficiaryStore(path: string) {
  const store = {
    path,
    exists: (): boolean => existsSync(path),
    read(): BeneficiaryFile {
      return JSON.parse(readFileSync(path, 'utf-8')) as BeneficiaryFile
    },
    write(file: BeneficiaryFile): string {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, stringifyJson(file))
      return path
    },
    toMap(file: BeneficiaryFile): BeneficiaryMap {
      return new Map(file.entries.map((entry) => [entry.address, withoutAddress(entry)]))
    },
    fromMap(map: BeneficiaryMap): BeneficiaryFile {
      const entries = [...map]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([address, beneficiary]) => ({ address, ...beneficiary }))
      return { entries }
    },
    /** The cached map, empty when no file exists yet. */
    readMap(): BeneficiaryMap {
      return store.exists() ? store.toMap(store.read()) : new Map()
    },
  }
  return store
}

export type BeneficiaryStore = ReturnType<typeof createBeneficiaryStore>
