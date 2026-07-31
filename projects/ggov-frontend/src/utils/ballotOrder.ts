/**
 * Per-browser candidate ordering on an election ballot.
 *
 * Ballot position is worth votes. On-chain a period's candidates sit in whatever
 * order the operator added them, and showing that one order to every voter hands
 * the top of the list a standing advantage that has nothing to do with the
 * candidates. Each browser therefore draws its own permutation, so across the
 * electorate no position is favoured.
 *
 * The permutation must be **stable**: a voter scrolls away, refreshes, or comes
 * back the next day to change their vote, and the ballot has to look the same or
 * they can't trust what they already scored. So it is *derived*, never shuffled —
 * a random nonce generated once per browser and kept in localStorage seeds a hash
 * per candidate, and the candidates sort by that hash.
 *
 * Only candidates are reordered. A standard period's topics keep their on-chain
 * order: those are authored decisions, and the operator's sequence carries meaning.
 */

const NONCE_KEY = 'ggov:ballot-nonce'

/** A nonce we wrote: 32 lowercase hex chars. Anything else gets regenerated. */
const NONCE_RE = /^[0-9a-f]{32}$/

/** 128 bits — far more permutations than there are voters, so orders don't collide. */
function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Read-and-maybe-create runs once per page load: the value must not change between
// two calls in the same session, or two lists seeded from it would disagree.
let cached: string | null | undefined

/**
 * This browser's ballot nonce, creating and persisting one on first use, or `null`
 * when storage is unavailable.
 *
 * Browser-only — it touches `localStorage`. Components read it through
 * {@link useBallotNonce}, which keeps it out of the server render.
 */
export function readBallotNonce(): string | null {
  if (cached !== undefined) return cached
  try {
    const stored = localStorage.getItem(NONCE_KEY)
    if (stored && NONCE_RE.test(stored)) {
      cached = stored
    } else {
      const nonce = generateNonce()
      localStorage.setItem(NONCE_KEY, nonce)
      cached = nonce
    }
  } catch {
    // Private-mode Safari, disabled storage, no crypto: a nonce we can't persist
    // would give a different order on every reload, which is worse than an order
    // that is merely unfair. Fall back to the on-chain order instead.
    cached = null
  }
  return cached
}

/** Forget the cached nonce so the next read re-reads storage. Tests and stories only. */
export function resetBallotNonceCache() {
  cached = undefined
}

/**
 * FNV-1a (32-bit) plus murmur3's `fmix32` finaliser. Not a security primitive —
 * just a mixer that has to spread *well*, because a biased one silently
 * reintroduces the positional advantage this module exists to remove.
 *
 * Bare FNV-1a is not good enough here: it avalanches poorly in the bytes it
 * consumed last, so hashing inputs that differ only in a trailing candidate index
 * produced near-sorted ranks (adjacent candidates merely swapping). The finaliser
 * fixes the avalanche; {@link orderByNonce} additionally puts the varying part
 * first. Measured over 200k synthetic browsers, every candidate then lands in
 * every position equally often.
 */
function hash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Order `items` by the permutation `nonce` induces, or leave them in on-chain
 * order when there is no nonce (server render, or storage unavailable).
 *
 * `scope` separates one list's permutation from another's — pass something that
 * identifies the race, so two elections on the same ballot shuffle independently
 * rather than in lockstep. `keyOf` must return a value that identifies the item
 * within that scope for good (the on-chain topic index), never its current
 * position: keying on position would make the order depend on itself.
 */
export function orderByNonce<T>(
  items: readonly T[],
  nonce: string | null,
  scope: string,
  keyOf: (item: T) => string | number,
): T[] {
  if (!nonce) return items.slice()
  return (
    items
      // Key first, nonce last: the item's key is the only part that varies within a
      // list, and a hash mixes its early input far more thoroughly than its last
      // few bytes. See {@link hash}.
      .map((item, index) => ({ item, index, rank: hash(`${keyOf(item)}|${scope}|${nonce}`) }))
      // Ties are astronomically unlikely but must not reorder run to run, so the
      // original index settles them and keeps the sort total.
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.item)
  )
}
