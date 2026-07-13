import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationInstanceArgs, FracDelegationInstanceComposer } from '../generated/FracDelegationInstanceClient'
import { SenderWithSigner } from '../types'

// Re-export shared primitives so the public surface is unchanged.
export type { Network, SenderWithSigner, SendResult } from '../types'

export type InstanceReaderConstructorArgs = {
  algorand: AlgorandClient
  /** Frac delegation instance app id. Instances are per-protocol; there is no network default. */
  instanceAppId: number | bigint
  /**
   * Funded account used as the simulate sender for reads (never signs). Defaults to the
   * testnet/localnet fee sink; pass the mainnet fee sink (or any funded account) on mainnet.
   */
  readerAccount?: string
  concurrency?: number
  debug?: boolean
}

export type InstanceConstructorArgs = {
  writerAccount?: SenderWithSigner
} & InstanceReaderConstructorArgs

export interface InstanceMethodBuilderArgs {
  builder?: FracDelegationInstanceComposer<any>
  /** Optional transaction note. Useful for deduplicating otherwise-identical transactions. */
  note?: string | Uint8Array
}

export type FracDelegationInstanceContractArgs = FracDelegationInstanceArgs['obj']
