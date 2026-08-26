import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  COUNCIL_SEATS,
  buildCouncilElection,
  firstName,
  nfdOf,
  type VotingSessionFixture,
} from '../../src/mirror/council-election.ts'

const fixture = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL('../../../common/gov-fixtures/voting-session-period-15-voting-session-1.json', import.meta.url),
    ),
    'utf-8',
  ),
) as VotingSessionFixture

describe('buildCouncilElection', () => {
  const election = buildCouncilElection(fixture)

  it('mirrors the shape of the real first election', () => {
    expect(election.candidates).toHaveLength(fixture.topics.length)
    expect(election.elect).toEqual([{ t: 'xGov Council', s: COUNCIL_SEATS }])
    expect(election.options).toEqual(['Support', 'Veto', 'Abstain'])
    expect(election.title).toBe('xGov Council Election Term 2')
    expect(election.body).toContain('the second xGov council election')
    expect(election.body).toContain('one of three options: support, veto, abstain')
    expect(election.body).not.toMatch(/<[a-z]+>/)
  })

  it('mocks every candidate — no real name, application link or handle survives', () => {
    const realNames = fixture.topics.map((t) => t.title)
    const realSurnames = realNames.map((n) => n.split(' ').at(-1)!)
    const text = JSON.stringify(election)
    for (const surname of realSurnames) expect(text).not.toContain(surname)
    expect(text).not.toContain('xgov_council-9.md')
    expect(text).not.toContain('fifthrace')
    for (const c of election.candidates) {
      expect(c.body).toContain('**Experience summary**')
      expect(c.body).toContain(`full application (${c.pr})`)
      expect(c.body).toContain(c.affiliations.join(', '))
      expect(c.body).toContain(`https://app.nf.domains/name/${c.nfd}`)
      expect(c.body).toContain(`Do you support ${c.name} for the xGov Council?`)
    }
  })

  it('is deterministic, unique per candidate, and ordered by surname', () => {
    expect(buildCouncilElection(fixture)).toEqual(election)
    expect(new Set(election.candidates.map((c) => c.name)).size).toBe(election.candidates.length)
    expect(new Set(election.candidates.map((c) => c.pr)).size).toBe(election.candidates.length)
    const surnames = election.candidates.map((c) => c.name.split(' ').at(-1)!)
    expect(surnames).toEqual([...surnames].sort((a, b) => a.localeCompare(b, 'en')))
  })

  it('name helpers skip honorifics and strip accents', () => {
    expect(firstName('Dr. Helena Marchetti')).toBe('Helena')
    expect(firstName('Sun-Hee Park')).toBe('Sun-Hee')
    expect(nfdOf('Søren Lindqvist')).toBe('sorenlindqvist.algo')
    expect(nfdOf('Dr. Lucía Ferrer')).toBe('luciaferrer.algo')
  })
})
