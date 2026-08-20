/**
 * Liquid-staking token vs. Réti validator pool — shared by the pools index (its
 * filter) and one pool's detail page (its eyebrow), so the two never disagree
 * about what a pool is.
 *
 * TODO(data): derived from the pool's name, because that is the only descriptive
 * field the registry keeps — `FracInstance` is `{ appId, name, numAccounts,
 * numEscrows }` and nothing in it records what kind of pool an instance wraps.
 * So this is a naming convention, not a fact: a Réti instance that doesn't say
 * "Reti" lands in the liquid bucket. The fix is a `kind` (or a free-form tag) on
 * the instance record, set at `createInstance` — contract work, so a follow-up.
 * Until then the index only offers the filter when both buckets are populated.
 */

export type PoolKind = 'liquid' | 'reti'

export function poolKind(name: string): PoolKind {
  // Fold diacritics first: operators write both "Reti" and "Réti", and \b never
  // matches across the combining mark in the latter.
  const folded = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return /\breti\b/i.test(folded) ? 'reti' : 'liquid'
}

export const KIND_LABEL: Record<PoolKind, string> = {
  liquid: 'Liquid staking',
  reti: 'Réti pool',
}
