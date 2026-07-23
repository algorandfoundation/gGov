import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationRegistryArgs, FracDelegationRegistryComposer } from '../generated/FracDelegationRegistryClient'
import { Network, SenderWithSigner } from '../types'

// Re-export shared primitives so existing imports from this module keep working.
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

export interface CommonMethodBuilderArgs {
  builder?: FracDelegationRegistryComposer<any>
  note?: string | Uint8Array
}

export type FracDelegationRegistryContractArgs = FracDelegationRegistryArgs['obj']
