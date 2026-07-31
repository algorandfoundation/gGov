import type { Election } from 'ggov-sdk'

/**
 * What a period calls the things on its ballot, and how it counts them.
 *
 * There is one on-chain primitive — the topic. "Candidate" is the word the UI
 * uses for a topic once the period body declares elections, so this is a copy
 * concern only: `topicIndex` stays the handle everywhere in code.
 *
 * Kept in one place because the noun appears in ~30 strings across the vote,
 * results and manage surfaces, and they have already drifted apart once (the
 * add-candidate form said "Add topic" in its disconnected state).
 */
export interface PeriodTerms {
  isElection: boolean
  item: 'candidate' | 'topic'
  items: 'candidates' | 'topics'
  Item: 'Candidate' | 'Topic'
  Items: 'Candidates' | 'Topics'
  /** Races the period declares; 0 on a standard period. */
  electionCount: number
}

const STANDARD: PeriodTerms = {
  isElection: false,
  item: 'topic',
  items: 'topics',
  Item: 'Topic',
  Items: 'Topics',
  electionCount: 0,
}

/**
 * A period is an election period iff its body carries a **non-empty** `elect`.
 * There is no boolean flag on the period — see `PeriodBodyJson.elect`. Pass
 * `undefined` freely: the body is undefined while its query is in flight, and
 * the standard-period wording is the right thing to render meanwhile.
 */
export function periodTerms(elect?: readonly Election[] | null): PeriodTerms {
  if (!elect || elect.length === 0) return STANDARD
  return {
    isElection: true,
    item: 'candidate',
    items: 'candidates',
    Item: 'Candidate',
    Items: 'Candidates',
    electionCount: elect.length,
  }
}

/** `3 topics`, `1 candidate`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The one-line count a period summary shows.
 *
 * A ballot running several races is summarised by the races — "2 elections"
 * says more about what's being decided than "7 candidates" does. One race has
 * only one answer, so it counts its candidates instead; "1 election" would tell
 * a reader nothing they don't already see from the period title.
 */
export function periodCountLabel(topicCount: number, elect?: readonly Election[] | null): string {
  const terms = periodTerms(elect)
  return terms.electionCount > 1 ? plural(terms.electionCount, 'election') : plural(topicCount, terms.item)
}
