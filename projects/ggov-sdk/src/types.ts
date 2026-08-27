/** Shared primitives used by both the period and registry SDKs. */

export type Network = 'localnet' | 'testnet' | 'mainnet'

/** The account a write group is sent from, and how it signs — defined in `sdk-shared`. */
export type { SenderWithSigner, SendResult } from 'sdk-shared'
/** Adapt an algosdk signing account (post-quantum included) to `SenderWithSigner`. */
export { writerFromAddressWithSigners } from 'sdk-shared'

export type CommitteeId = Uint8Array | Buffer | string
