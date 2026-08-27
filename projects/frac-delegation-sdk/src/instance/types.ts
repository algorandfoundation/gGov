import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import {
  FracDelegationInstanceArgs,
  FracDelegationInstanceComposer,
} from '../generated/FracDelegationInstanceClient.js'
import { Network, SenderWithSigner } from '../types.js'

// Re-export shared primitives so the public surface is unchanged.
export type { Network, SenderWithSigner, SendResult } from '../types.js'
export { writerFromAddressWithSigners } from '../types.js'

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
  /**
   * Scratch cache owned by the executor, valid only for the duration of one write. The maker is
   * re-run up to three times while the group is sized, and anything it reads to size its own call
   * belongs in here rather than being fetched again on every rerun.
   */
  readCache?: Map<string, unknown>
}

export type FracDelegationInstanceContractArgs = FracDelegationInstanceArgs['obj']

/**
 * Off-chain AlgoQuarters manifest — the `AlgoQuartersData` shape emitted by the
 * frac delegation pipeline (one manifest per protocol per period window).
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
