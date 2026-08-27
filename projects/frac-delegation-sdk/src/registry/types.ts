import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import {
  FracDelegationRegistryArgs,
  FracDelegationRegistryComposer,
} from '../generated/FracDelegationRegistryClient.js'
import { Network, SenderWithSigner } from '../types.js'

// Re-export shared primitives so existing imports from this module keep working.
export type { Network, SenderWithSigner, SendResult } from '../types.js'

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

export interface CommonMethodBuilderArgs {
  builder?: FracDelegationRegistryComposer<any>
  note?: string | Uint8Array
  /**
   * Scratch cache owned by the executor, valid only for the duration of one write. The maker is
   * re-run up to three times while the group is sized, and anything it reads to size its own call
   * belongs in here rather than being fetched again on every rerun.
   */
  readCache?: Map<string, unknown>
}

export type FracDelegationRegistryContractArgs = FracDelegationRegistryArgs['obj']
