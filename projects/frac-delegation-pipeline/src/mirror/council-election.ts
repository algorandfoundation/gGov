/**
 * A fake second xGov Council election, shaped after the real first one (governance period 15,
 * voting session 1 — `common/gov-fixtures/voting-session-period-15-voting-session-1.json`).
 *
 * What is taken from the fixture is the *shape*: the session description (adapted to a second
 * term), the candidate count, the one-measure-per-candidate ballot with Yes/No/Abstain, and the
 * layout every candidate application follows (experience summary, application link, project
 * affiliations, social profiles, the closing question). Every candidate is otherwise invented:
 * names, bios, products, handles and links are mocked, deterministically, so re-runs and networks
 * agree on the ballot and no real person's application is replayed.
 */

import type { Election } from 'ggov-sdk'

export type FixtureTopic = { title: string; description_html: string }
export type VotingSessionFixture = {
  short_description: string
  description_html: string
  voting_start_datetime: string
  voting_end_datetime: string
  topics: FixtureTopic[]
}

export type MockCandidate = {
  name: string
  /** Mock NFD, doubles as the candidate's handle everywhere. */
  nfd: string
  /** Mock "PR-NN" application reference. */
  pr: string
  affiliations: string[]
  /** Markdown body of the candidate's measure. */
  body: string
}

export type CouncilElection = {
  title: string
  body: string
  elect: Election[]
  candidates: MockCandidate[]
  /** Options every candidate carries, Abstain last — frac voting relies on that. */
  options: string[]
}

/** Seats the first council had: 11 councillors, with 12th and 13th forming the reserve pool. */
export const COUNCIL_SEATS = 11

// =========================================================
// MOCK DATA
// =========================================================

/** Fictional candidates, one per fixture topic; more entries than the fixture has are unused. */
const NAMES = [
  'Mira Castellane',
  'Teodor Brankovic',
  'Anouk Verheyden',
  'Rafael Quintero',
  'Imani Okonkwo',
  'Søren Lindqvist',
  'Priya Raghunathan',
  'Yusuf Demirel',
  'Dr. Helena Marchetti',
  'Kenji Watanabe',
  'Lucía Ferrer',
  'Oskar Nyström',
  'Amara Diallo',
  'Matthias Reinholt',
  'Zofia Kowalczyk',
  'Diego Salazar',
  'Ingrid Halvorsen',
  'Tariq Haddad',
  'Beatriz Almeida',
  'Callum Whitfield',
  'Sun-Hee Park',
  'Elias Vandermeer',
  'Noor Rahimi',
  'Gustavo Peixoto',
]

/** Fictional ecosystem products a candidate can be affiliated with. */
const PRODUCTS = [
  'Lattice Wallet',
  'Quorum Analytics',
  'Meridian DEX',
  'StakeWeaver',
  'Boxcar Indexer',
  'Halcyon Lending',
  'Signet NFTs',
  'Ferrite Node Ops',
  'Cobalt Bridge',
  'Tessera Tooling',
  'Aurora Payments',
  'Pebble Games',
  'Vantage Oracle',
  'Orbital Education',
  'Clearwater Treasury',
  'Nimbus Hosting',
  'Ledgerline Compliance',
  'Sunstone Grants',
]

const BACKGROUNDS = [
  'software development, engineering management and cloud architecture in the SaaS world',
  'protocol research, consensus engineering and distributed-systems security',
  'product management, UX research and community operations for consumer fintech',
  'quantitative finance, treasury management and DeFi risk modelling',
  'developer relations, technical writing and open-source maintenance',
  'legal and regulatory advisory for digital-asset businesses across three jurisdictions',
  'validator operations, node infrastructure and site reliability engineering',
  'academic research in cryptography and formal verification, with a decade of teaching',
  'venture investing, startup mentoring and ecosystem grant programme design',
  'data engineering, on-chain analytics and indexer tooling',
  'game development, digital collectibles and creator-economy platforms',
  'enterprise integration, payments and supply-chain traceability',
]

const STRENGTHS = [
  'bringing together diverse stakeholders and aligning on priorities to reach consensus',
  'turning long forum threads into concrete, reviewable proposals',
  'reading budgets and milestone reports critically, and saying so early',
  'moderating disagreement without letting it stall a decision',
  'documenting decisions so the next cohort can pick up where this one left off',
  'keeping technical and non-technical governors on the same page',
]

const ENGAGEMENT = [
  'regularly engages in community discussions on Discord, X and the Algorand Forum',
  'has published educational content on Algorand and maintains a governance newsletter',
  'hosts a monthly community call and reviews xGov proposals in public',
  'contributes to open-source Algorand tooling and answers developer questions daily',
  'has voted in every governance period since the programme began',
  'organises regional meetups and onboarding workshops for new governors',
]

// =========================================================
// BUILDER
// =========================================================

/** Small deterministic PRNG so the mock data is stable across runs and networks. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rand: () => number, list: T[]): T => list[Math.floor(rand() * list.length)]

/** `"Dr. Helena Marchetti"` → `"Helena"`; `"Sun-Hee Park"` → `"Sun-Hee"`. */
export function firstName(name: string): string {
  return name.split(' ').find((part) => !part.endsWith('.')) ?? name
}

/** `"Dr. Helena Marchetti"` → `"helenamarchetti.algo"`. */
export function nfdOf(name: string): string {
  return `${name
    .split(' ')
    .filter((part) => !part.endsWith('.'))
    .join('')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o')
    .replace(/ł/gi, 'l')
    .replace(/ß/g, 'ss')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase()}.algo`
}

/** Fisher–Yates on a copy. */
function shuffle<T>(rand: () => number, list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function candidateBody(c: Omit<MockCandidate, 'body'>, rand: () => number): string {
  const first = firstName(c.name)
  const years = 5 + Math.floor(rand() * 20)
  return [
    '**Experience summary**',
    '',
    `${first} has over ${years} years of experience covering ${pick(rand, BACKGROUNDS)}. ` +
      `${first} has a track record of ${pick(rand, STRENGTHS)}, understands governance processes and ` +
      `community engagement, and ${pick(rand, ENGAGEMENT)}.`,
    '',
    `[Read ${first}’s full application (${c.pr}) before voting]` +
      `(https://github.com/algorandfoundation/xGov/blob/main/Council/xgov_council-term2-${c.pr.toLowerCase()}.md)`,
    '',
    '**Project affiliations**',
    c.affiliations.join(', '),
    '',
    '**Social profiles**',
    `X [https://x.com/${c.nfd.replace('.algo', '')}](https://x.com/${c.nfd.replace('.algo', '')})`,
    `NFD [https://app.nf.domains/name/${c.nfd}](https://app.nf.domains/name/${c.nfd})`,
    '',
    `Do you support ${c.name} for the xGov Council?`,
  ].join('\n')
}

/**
 * Rewrite the first election's description for the second one. Sentences that are specific to the
 * first election are swapped; the process description is kept as-is.
 */
function secondTermDescription(firstTermHtml: string): string {
  const md = htmlToMarkdown(firstTermHtml)
  return md
    .replace(
      /As we begin the unincentivized governance era, we would like to thank all governors for participating in this democratic process\./,
      'One term into the unincentivized governance era, we would like to thank all governors for participating in this democratic process.',
    )
    .replace(/the first xGov council election/g, 'the second xGov council election')
    .replace(/For the first implementation, /, 'For the second term, ')
    .replace(/will form the first 12-month council with cohort/, 'will form the second 12-month council cohort')
}

/**
 * Build the fake election from the fixture. `seed` varies the invented bios and affiliations
 * without changing who the candidates are.
 */
export function buildCouncilElection(fixture: VotingSessionFixture, seed = 2): CouncilElection {
  const rand = mulberry32(seed)
  if (fixture.topics.length > NAMES.length) {
    throw new Error(`fixture has ${fixture.topics.length} candidates but only ${NAMES.length} mock names`)
  }
  // The real first-term ballot listed candidates alphabetically by surname; mirror that.
  const names = NAMES.slice(0, fixture.topics.length).sort((a, b) =>
    a.split(' ').at(-1)!.localeCompare(b.split(' ').at(-1)!, 'en'),
  )
  const prNumbers = shuffle(
    rand,
    Array.from({ length: names.length }, (_, i) => i + 1),
  )
  const candidates: MockCandidate[] = names.map((name, i) => {
    const affiliations = shuffle(rand, PRODUCTS).slice(0, 1 + Math.floor(rand() * 3))
    const head = { name, nfd: nfdOf(name), pr: `PR-${String(prNumbers[i]).padStart(2, '0')}`, affiliations }
    return { ...head, body: candidateBody(head, rand) }
  })

  return {
    title: fixture.short_description.replace(/\d{4}/, 'Term 2'),
    body: secondTermDescription(fixture.description_html),
    elect: [{ t: 'xGov Council', s: COUNCIL_SEATS }],
    candidates,
    options: ['Yes', 'No', 'Abstain'],
  }
}

/**
 * The fixtures' `description_html` as Markdown for the markdown-rendering frontend. Handles the
 * HTML the period-15 fixtures contain — <p>, <ul>/<li>, <strong>/<b>, <em>/<i>, <a href>, <br> and
 * the &rsquo; family of entities; unknown tags are stripped. (Same routine as
 * `common/gov-fixtures/replay-period-15.ts`, which is a script and exports nothing.)
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let s = html
  s = s.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${txt.trim()}](${href})`)
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${txt.trim()}**`)
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${txt.trim()}*`)
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt) => `- ${txt.trim()}\n`)
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '')
  s = s.replace(/<[^>]+>/g, '')
  const entities: Record<string, string> = {
    '&rsquo;': '’',
    '&lsquo;': '‘',
    '&ldquo;': '“',
    '&rdquo;': '”',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  }
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => entities[m] ?? m)
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
