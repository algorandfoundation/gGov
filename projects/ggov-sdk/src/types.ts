import { Address, TransactionSigner } from 'algosdk'
import {
  SendSingleTransactionResult,
  SendAtomicTransactionComposerResults,
} from '@algorandfoundation/algokit-utils/types/transaction'

/** Shared primitives used by both the period and registry SDKs. */

export type Network = 'localnet' | 'testnet' | 'mainnet'

export type SenderWithSigner = {
  sender: Address | string
  signer: TransactionSigner
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults

export type CommitteeId = Uint8Array | Buffer | string
