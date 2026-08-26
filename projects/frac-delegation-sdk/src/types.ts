import { Address, TransactionSigner } from 'algosdk'
import {
  SendSingleTransactionResult,
  SendAtomicTransactionComposerResults,
} from '@algorandfoundation/algokit-utils/types/transaction'

/** Shared primitives used by the frac-delegation SDKs. */

export type Network = 'localnet' | 'testnet' | 'mainnet'

export type SenderWithSigner = {
  sender: Address | string
  signer: TransactionSigner
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults
