/** Shared primitives used by the frac-delegation SDKs. */

export type Network = 'localnet' | 'testnet' | 'mainnet'

/** The account a write group is sent from, and how it signs — defined in `sdk-shared`. */
export type { SenderWithSigner, SendResult } from 'sdk-shared'
/** Adapt an algosdk signing account (post-quantum included) to `SenderWithSigner`. */
export { writerFromAddressWithSigners } from 'sdk-shared'
