import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationInstanceArgs, FracDelegationInstanceComposer } from '../generated/FracDelegationInstanceClient'
import { Network, SenderWithSigner } from '../types'

// Re-export shared primitives so the public surface is unchanged.
export type { Network, SenderWithSigner, SendResult } from '../types'

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

export interface InstanceMethodBuilderArgs {
  builder?: FracDelegationInstanceComposer<any>
  /** Optional transaction note. Useful for deduplicating otherwise-identical transactions. */
  note?: string | Uint8Array
}

export type FracDelegationInstanceContractArgs = FracDelegationInstanceArgs['obj']

/**
 * Off-chain AlgoQuarters manifest — the `AlgoQuartersData` shape emitted by the
 * `ggov-algoquarters` pipeline (one file per protocol per period window).
 */
export interface AlgoQuartersFile {
  networkGenesisHash: string
  /** Protocol from which the algoquarters were calculated. */
  protocol: string
  periodStart: number
  periodEnd: number
  /** Liquid-token/ALGO rate for the window (12-decimal fixed-point string). Absent for native staking. */
  rate?: string
  /** Number of eligible accounts. */
  totalAccounts: number
  /** Sum of all accounts' algoquarters (bigint as decimal string). */
  totalAlgoQuarters: string
  /** Eligible accounts only (each ≥ 1 AQ), sorted ascending by address. */
  accounts: Array<{ account: string; algoQuarters: string }>
}
