import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import { GGovRegistryArgs, GGovRegistryComposer } from '../generated/GGovRegistryClient.js'
import { Network, SenderWithSigner } from '../types.js'

// Re-export shared primitives so existing imports from this module keep working.
export type { Network, SenderWithSigner, SendResult, CommitteeId } from '../types.js'

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

export interface GGovCommitteeFile {
  networkGenesisHash: string
  periodEnd: number
  periodStart: number
  registryId: number
  totalMembers: number
  totalVotes: number
  govs: Array<{
    address: string
    votes: number
  }>
}

export type AccountWithVotes = {
  account: Address | string
  votes: number
}

type ID = number
type Votes = number
export type StoredGov = [ID, Votes]
export const STORED_GOV_BYTE_LENGTH = 8 // 4 bytes for ID + 4 bytes for Votes

export interface CommonMethodBuilderArgs {
  builder?: GGovRegistryComposer<any>
  note?: string | Uint8Array
  /**
   * Scratch cache owned by the executor, valid only for the duration of one write. The maker is
   * re-run up to three times while the group is sized, and anything it reads to size its own call
   * belongs in here rather than being fetched again on every rerun.
   */
  readCache?: Map<string, unknown>
}

export type GGovRegistryContractArgs = GGovRegistryArgs['obj']
