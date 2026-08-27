/**
 * Random note fragment to keep otherwise-identical transactions from colliding into one duplicate
 * txn ID — the node rejects a byte-identical txn as already-in-ledger while the earlier one is
 * inside its validity window. Used for padding app calls and idempotent re-uploads.
 */
export const noteNonce = () => Math.floor(Math.random() * 100_000_000)
