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
