import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovRegistryArgs } from '../generated/GGovRegistryClient'
import { GGovPeriodArgs, GGovPeriodComposer } from '../generated/GGovPeriodClient'
import { Network, SenderWithSigner } from '../types'

// Re-export shared primitives so the public surface is unchanged.
export type { Network, SenderWithSigner, SendResult, CommitteeId } from '../types'

export type ConstructorArgsOptions =
  | {
      network: Network
    }
  | {
      registryAppId: number | bigint
      readerAccount?: string
    }

export type ConstructorArgs = {
  writerAccount?: SenderWithSigner
} & ReaderConstructorArgs

export type ReaderConstructorArgs = {
  algorand: AlgorandClient
  concurrency?: number
  debug?: boolean
} & ConstructorArgsOptions

export interface PeriodMethodBuilderArgs {
  builder?: GGovPeriodComposer<any>
  /** Optional transaction note. */
  note?: string | Uint8Array
}

export type GGovRegistryContractArgs = GGovRegistryArgs['obj']
export type GGovPeriodContractArgs = GGovPeriodArgs['obj']

/** Fields every on-chain body box — period or topic — carries. */
export interface BodyJson {
  title: string
  body: string
}

/**
 * One election within a period, stored in the period body's {@link PeriodBodyJson.elect}.
 *
 * The keys are single characters deliberately: this list lives in the period's
 * on-chain body box, and `{ t, s }` costs ~13 bytes of JSON structure per election
 * against ~24 for `{ title, seats }`. Treat it as a wire format — unpack it at the
 * read boundary rather than threading `t`/`s` through application code.
 */
export interface Election {
  /** Title — the human-readable election name (non-empty). */
  t: string
  /** Seats — the top-K threshold; the `s` highest-scoring candidates lead. */
  s: number
}

/** Period body JSON: a {@link BodyJson} that may declare the period's elections. */
export interface PeriodBodyJson extends BodyJson {
  /**
   * The period's elections, in order. Its **presence** is what makes a period an
   * election period, and a period running a single election is simply the one-entry
   * form, `elect: [{ t, s }]`. A candidate joins one by carrying that election's
   * index in its own {@link TopicBodyJson.e}.
   *
   * **Append-stable:** because `e` is an index, reordering or removing an entry
   * silently re-tags every candidate pointing past it. Append at the end; to drop
   * an election, re-tag or remove its candidates first.
   */
  elect?: Election[]
}

/** Topic body JSON: a {@link BodyJson} that may name the election the topic runs in. */
export interface TopicBodyJson extends BodyJson {
  /**
   * Election index into the period body's {@link PeriodBodyJson.elect}. Absent on a
   * standard period's topics. Absent on an election period's candidate means
   * *unassigned*, which is reported as an error before `setReady` rather than
   * defaulted to `0` — otherwise an authoring slip silently enters a candidate in
   * whichever race happens to be first.
   */
  e?: number
}

/** Narrow to a plain (non-array) object so `title`/`body` lookups are meaningful. */
function asRecord(obj: unknown): Record<string, unknown> | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  return obj as Record<string, unknown>
}

function hasBodyFields(o: Record<string, unknown>): boolean {
  return typeof o.title === 'string' && typeof o.body === 'string'
}

/** A safe non-negative integer — the shape of an election index and (at >= 1) a seat count. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function isElection(v: unknown): v is Election {
  const o = asRecord(v)
  if (!o) return false
  if (typeof o.t !== 'string' || o.t.trim() === '') return false
  return isCount(o.s) && o.s >= 1
}

/**
 * Validate a period body. `elect`, when present, must be a **non-empty** list of
 * `{ t, s }`: an empty list would mark the period an election period while offering
 * no race for any candidate to join.
 */
export function validatePeriodBodyJson(obj: unknown): obj is PeriodBodyJson {
  const o = asRecord(obj)
  if (!o || !hasBodyFields(o)) return false
  if (o.elect === undefined) return true
  return Array.isArray(o.elect) && o.elect.length > 0 && o.elect.every(isElection)
}

/**
 * Validate a topic body. `e`, when present, must be a safe non-negative integer.
 * Whether it names a *declared* election is a period-level question — see
 * `validateAssignment`, which cross-checks the tags against the period's `elect`.
 */
export function validateTopicBodyJson(obj: unknown): obj is TopicBodyJson {
  const o = asRecord(obj)
  if (!o || !hasBodyFields(o)) return false
  return o.e === undefined || isCount(o.e)
}

function parseWith<T>(raw: Uint8Array, validate: (obj: unknown) => obj is T): T | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw))
    return validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parse a period body box payload; null if it isn't valid period-shaped JSON. */
export const parsePeriodBodyJson = (raw: Uint8Array): PeriodBodyJson | null => parseWith(raw, validatePeriodBodyJson)

/** Parse a topic body box payload; null if it isn't valid topic-shaped JSON. */
export const parseTopicBodyJson = (raw: Uint8Array): TopicBodyJson | null => parseWith(raw, validateTopicBodyJson)
