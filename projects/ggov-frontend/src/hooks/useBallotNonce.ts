import { startTransition, useEffect, useState } from 'react'
import { readBallotNonce } from '@/utils/ballotOrder'

/**
 * This browser's ballot nonce, or `null` until it is known.
 *
 * Deliberately `null` for the server render *and* the hydrating render: the nonce
 * lives in `localStorage`, which the server can't see, so reading it during render
 * would order the two passes differently and break hydration. Callers fall back to
 * the on-chain order while it's null and re-render into their own permutation once
 * mounted — a reorder on an already-painted list, which only shows on the read-only
 * views. The ballot itself needs a connected wallet, so it is client-only anyway.
 *
 * See {@link orderByNonce} for what the nonce is for.
 */
export function useBallotNonce(): string | null {
  const [nonce, setNonce] = useState<string | null>(null)
  useEffect(() => {
    // A transition, not an urgent update: reordering a list nobody has read yet
    // must never pre-empt hydration (React warns when it does, and drops the
    // boundary to client rendering).
    startTransition(() => setNonce(readBallotNonce()))
  }, [])
  return nonce
}
