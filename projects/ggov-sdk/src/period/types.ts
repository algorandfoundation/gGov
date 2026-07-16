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

/** Schema for topic and base period body JSON stored on-chain */
export interface BodyJson {
  title: string
  body: string
}

/** Period body JSON: a {@link BodyJson} that may carry election metadata. */
export interface PeriodBodyJson extends BodyJson {
  /**
   * Number of seats being elected on an election-type period (a safe positive
   * integer). Omitted on non-election periods.
   */
  electSeats?: number
}

export function validateBodyJson(obj: unknown): obj is PeriodBodyJson {
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as Record<string, unknown>
  if (typeof o.title !== 'string' || typeof o.body !== 'string') return false
  if (
    o.electSeats !== undefined &&
    (typeof o.electSeats !== 'number' || !Number.isSafeInteger(o.electSeats) || o.electSeats < 1)
  ) {
    return false
  }
  return true
}

export function parseBodyJson(raw: Uint8Array): PeriodBodyJson | null {
  try {
    const text = new TextDecoder().decode(raw)
    const parsed = JSON.parse(text)
    if (validateBodyJson(parsed)) return parsed
    return null
  } catch {
    return null
  }
}
