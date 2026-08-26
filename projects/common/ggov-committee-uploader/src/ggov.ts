/**
 * Helpers for fetching xGov committee data and deriving gGov committee files.
 *
 * gGov committees are built from the published xGov committees served at
 * https://xgov-committees.algorand.tech/ :
 *
 *   - members come from the xGov **candidate** committee
 *     (`/candidate-committee/<from>-<to>.json`), a flat `{ address: votes }` map.
 *   - metadata (network genesis hash, period bounds) comes from the matching
 *     xGov committee file (`/committee/<from>-<to>.json`), but with
 *     `registryId` overridden (default `1`, a placeholder for the eventual
 *     mainnet gGov registry deployment).
 *
 * `totalMembers` / `totalVotes` are recomputed from the candidate members so
 * they always describe the `govs` array we actually upload.
 */

/** Mainnet xGov committee host + network path segment. */
export const DEFAULT_BASE_URL = 'https://xgov-committees.algorand.tech'
export const DEFAULT_NETWORK_PATH = 'mainnet-v1.0-wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8_'

/** Placeholder xGov registry id for the (not-yet-deployed) gGov mainnet registry. */
export const DEFAULT_REGISTRY_ID = 1

/** Canonical committee file shape — mirrors `GGovCommitteeFile` in ggov-sdk. */
export interface CommitteeFile {
  networkGenesisHash: string
  periodEnd: number
  periodStart: number
  registryId: number
  totalMembers: number
  totalVotes: number
  govs: Array<{ address: string; votes: number }>
}

/** A single committee listed in `/committee/index.json`. */
export interface IndexCommittee {
  fromRound: number
  toRound: number
  committeeId: string
  totalMembers: number
  totalVotes: number
}

interface CommitteeIndex {
  committees: Record<string, IndexCommittee>
  lastUpdated?: string
  totalCommittees?: number
}

export interface XGovSourceOptions {
  baseUrl?: string
  networkPath?: string
}

function periodPath(c: { fromRound: number; toRound: number }): string {
  return `${c.fromRound}-${c.toRound}`
}

function urlFor(opts: XGovSourceOptions | undefined, ...segments: string[]): string {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL
  const networkPath = opts?.networkPath ?? DEFAULT_NETWORK_PATH
  return [baseUrl.replace(/\/$/, ''), networkPath, ...segments].join('/')
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

/** Fetch the committee index and return its entries sorted by period. */
export async function fetchCommitteeIndex(opts?: XGovSourceOptions): Promise<IndexCommittee[]> {
  const index = await fetchJson<CommitteeIndex>(urlFor(opts, 'committee', 'index.json'))
  return Object.values(index.committees).sort((a, b) => a.toRound - b.toRound)
}

/** Fetch the xGov committee metadata file (`/committee/<from>-<to>.json`). */
export async function fetchCommitteeMetadata(
  committee: { fromRound: number; toRound: number },
  opts?: XGovSourceOptions,
): Promise<CommitteeFile> {
  return fetchJson<CommitteeFile>(urlFor(opts, 'committee', `${periodPath(committee)}.json`))
}

/** Fetch the xGov candidate committee (`/candidate-committee/<from>-<to>.json`). */
export async function fetchCandidateCommittee(
  committee: { fromRound: number; toRound: number },
  opts?: XGovSourceOptions,
): Promise<Record<string, number>> {
  return fetchJson<Record<string, number>>(urlFor(opts, 'candidate-committee', `${periodPath(committee)}.json`))
}

/**
 * Build a gGov committee file for a single period.
 *
 * Field order matches the xGov committee file so the committee id (a hash of
 * `JSON.stringify(file)`) is computed over a canonical, reproducible layout.
 * Members are sorted by address ascending, matching the xGov convention.
 */
export function buildGGovCommitteeFile(
  metadata: CommitteeFile,
  candidates: Record<string, number>,
  registryId: number = DEFAULT_REGISTRY_ID,
): CommitteeFile {
  const govs = Object.entries(candidates)
    .map(([address, votes]) => ({ address, votes }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))

  const totalVotes = govs.reduce((sum, { votes }) => sum + votes, 0)

  return {
    networkGenesisHash: metadata.networkGenesisHash,
    periodEnd: metadata.periodEnd,
    periodStart: metadata.periodStart,
    registryId,
    totalMembers: govs.length,
    totalVotes,
    govs,
  }
}

/** Fetch + assemble the gGov committee file for one period. */
export async function buildGGovCommitteeForPeriod(
  committee: { fromRound: number; toRound: number },
  registryId: number = DEFAULT_REGISTRY_ID,
  opts?: XGovSourceOptions,
): Promise<CommitteeFile> {
  const [metadata, candidates] = await Promise.all([
    fetchCommitteeMetadata(committee, opts),
    fetchCandidateCommittee(committee, opts),
  ])
  return buildGGovCommitteeFile(metadata, candidates, registryId)
}

/** Filename used for a built gGov committee file. */
export function committeeFileName(file: { periodStart: number; periodEnd: number }): string {
  return `${file.periodStart}-${file.periodEnd}.json`
}
