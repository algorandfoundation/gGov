import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address, TransactionSigner } from 'algosdk'
import { DelegatorArgs, DelegatorComposer, GlobalKeysState } from './generated/DelegatorClient'
import {
  SendSingleTransactionResult,
  SendAtomicTransactionComposerResults,
} from '@algorandfoundation/algokit-utils/types/transaction'

export type Network = 'mainnet' | 'testnet'

export type ConstructorArgsOptions =
  | {
      network: Network
    }
  | {
      delegatorAppId: number | bigint
      readerAccount?: string
    }

export type SenderWithSigner = {
  sender: Address | string
  signer: TransactionSigner
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
  builder?: DelegatorComposer<any>
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults

export type DelegatorContractArgs = DelegatorArgs['obj']

export type DelegatorGlobalState = GlobalKeysState

export type AccountWithAlgoHours = {
  account: Address | string
  algoHours: bigint
}

export type CommitteeId = Uint8Array | Buffer | string
