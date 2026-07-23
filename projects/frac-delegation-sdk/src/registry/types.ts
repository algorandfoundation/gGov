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

/**
 * Decoded shape of a `FracAccountVotingRecord` log emitted by `logAccountVotingRecords`: one
 * account's internal vote record in one frac instance, tagged with that instance's identity.
 * `topicVotes` is empty when the account has not voted for the period on that instance.
 *
 * Not emitted as a generated type (the contract method returns void and only logs), so it is
 * declared here to mirror the registry's `FracAccountVotingRecord` ARC-56 struct.
 */
export type FracAccountVotingRecord = {
  /** Registry-assigned numeric ID of the instance */
  instanceNumId: number
  /** On-chain app ID of the instance */
  instanceAppId: bigint
  /** Human-readable instance label */
  instanceName: string
  /** [topic][option] internal votes, in AlgoQuarters; empty if the account has not voted */
  topicVotes: number[][]
}

export type FracDelegationRegistryContractArgs = FracDelegationRegistryArgs['obj']
