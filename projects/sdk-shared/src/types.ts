import { Address, AddressWithEmptyTransactionSigner, AddressWithTransactionSigner, TransactionSigner } from 'algosdk'
import {
  SendSingleTransactionResult,
  SendAtomicTransactionComposerResults,
} from '@algorandfoundation/algokit-utils/types/transaction'

/** The account a write group is sent from, and how its transactions get signed. */
export type SenderWithSigner = {
  sender: Address | string
  signer: TransactionSigner
  /**
   * Placeholder signer used for the SDK's sizing simulates, so nobody is prompted to sign them.
   * Defaults to algosdk's `makeEmptyTransactionSigner()`.
   *
   * A post-quantum writer should pass the empty signer from `addressWithSignersFromRawPQSigner` —
   * {@link writerFromAddressWithSigners} does it in one call. The AVM v13 PQ premium (a flat 3x per
   * PQ-authorized transaction, measured) is priced off the signature envelope, not the sender
   * address, so a plain empty signer measures non-PQ usage for a PQ sender. Degrades safely: the
   * send-time fee retry still catches it, at the cost of one extra round trip.
   *
   * One signer covers the whole group, so a mixed-sender group — only `setVotingAccount`, which
   * takes a per-call `sender` — is priced as if every transaction were PQ. That over-pays and never
   * fails; pricing it exactly would need a per-transaction signer map.
   */
  emptyTxnSigner?: TransactionSigner
}

/**
 * Adapt an algosdk signing account to the SDKs' writer shape.
 *
 * `addressWithSignersFromRawPQSigner` and `addressWithSignersFromRawFalcon1024Signer` both return
 * `{ address, txnSigner, emptyTxnSigner, ... }`, which is this type under different field names.
 */
export const writerFromAddressWithSigners = (
  account: AddressWithTransactionSigner & Partial<AddressWithEmptyTransactionSigner>,
): SenderWithSigner => ({
  sender: account.address,
  signer: account.txnSigner,
  emptyTxnSigner: account.emptyTxnSigner,
})

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults
