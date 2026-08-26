import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import type { GGovCommitteeFile } from 'ggov-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FracAccountClassifier, classifyCoreGovs, type EscrowLookup } from '../../src/mirror/classify.ts'
import { SubstitutionBook, TINYMAN_POOL_AUTH_ADDR, rewriteCommittee } from '../../src/mirror/substitutions.ts'

const addr = () => algosdk.generateAccount().addr.toString()
const [A, B, C, D, E] = Array.from({ length: 5 }, addr)

/** escreg stub: the given addresses are escrows of app 1001, 1002, … */
const escregOf = (...escrows: string[]): EscrowLookup & { calls: string[][] } => ({
  calls: [],
  async lookup({ addresses }) {
    this.calls.push(addresses)
    return Object.fromEntries(
      addresses.map((a) => [a, escrows.includes(a) ? BigInt(1001 + escrows.indexOf(a)) : undefined]),
    )
  },
})

const committee = (): GGovCommitteeFile => ({
  networkGenesisHash: 'x',
  periodStart: 1,
  periodEnd: 2,
  registryId: 1,
  totalMembers: 3,
  totalVotes: 60,
  govs: [
    { address: A, votes: 10 },
    { address: B, votes: 20 },
    { address: C, votes: 30 },
  ].sort((x, y) => (x.address < y.address ? -1 : 1)),
})

describe('classifyCoreGovs', () => {
  it('swaps app escrows that are not frac escrows, and never asks escreg about frac escrows', async () => {
    const escreg = escregOf(A, B)
    const out = await classifyCoreGovs({ addresses: [A, B, C], escrowAddresses: [B], escreg })
    expect([...out.keys()]).toEqual([A])
    expect(out.get(A)).toEqual({ reason: 'app-escrow', appId: 1001n })
    expect(escreg.calls).toEqual([[A, C]])
  })

  it('swaps Foundation accounts without asking escreg, unless they are frac escrows', async () => {
    const escreg = escregOf()
    const out = await classifyCoreGovs({ addresses: [A, B, C], escrowAddresses: [B], escreg, foundation: [A, B] })
    expect([...out]).toEqual([[A, { reason: 'foundation' }]])
    expect(escreg.calls).toEqual([[C]])
  })
})

describe('FracAccountClassifier', () => {
  it('picks app escrows and Tinyman pools only, and caches verdicts across calls', async () => {
    const escreg = escregOf(A)
    const asked: string[] = []
    const auth = {
      async authAddrOf(address: string) {
        asked.push(address)
        return address === B ? TINYMAN_POOL_AUTH_ADDR : address === C ? D : undefined
      },
    }
    const classifier = new FracAccountClassifier(escreg, auth, 2)
    const first = await classifier.classify([A, B, C, E])
    expect(first.get(A)).toEqual({ reason: 'app-escrow', appId: 1001n })
    expect(first.get(B)).toEqual({ reason: 'tinyman-pool' })
    expect(first.has(C)).toBe(false) // rekeyed, but not to the Tinyman signer
    expect(first.has(E)).toBe(false)
    expect(asked.sort()).toEqual([B, C, E].sort())

    const second = await classifier.classify([A, B, D])
    expect([...second.keys()]).toEqual([A, B])
    expect(escreg.calls).toEqual([[A, B, C, E], [D]])
    expect(asked.length).toBe(4) // only D was new
  })

  it('knows Foundation accounts up front', async () => {
    const escreg = escregOf()
    const classifier = new FracAccountClassifier(escreg, { authAddrOf: async () => undefined }, 2, [A])
    const out = await classifier.classify([A, B])
    expect([...out]).toEqual([[A, { reason: 'foundation' }]])
    expect(escreg.calls).toEqual([[B]])
  })
})

describe('SubstitutionBook + rewriteCommittee', () => {
  let dir: string
  let path: string
  const identity = { network: 'localnet', gGovRegistryAppId: 1002, fracRegistryAppId: 1006 }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirror-'))
    path = join(dir, '.synthetic-accounts.localnet.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('generates once, persists after every change, and reloads the same stand-ins', () => {
    const book = SubstitutionBook.open(path, identity)
    const first = book.getOrCreate(A, 'app-escrow', 1001n)
    expect(book.getOrCreate(A, 'app-escrow', 1001n)).toBe(first)
    book.addVotingPower(A, { kind: 'core', votes: 10, totalVotes: 60 })
    book.addVotingPower(A, { kind: 'core', votes: 10, totalVotes: 60 }) // idempotent
    book.addVotingPower(A, {
      kind: 'frac',
      instance: 'Reti #4',
      source: 'reti',
      algoQuarters: '5',
      totalAlgoQuarters: '50',
    })

    const reloaded = SubstitutionBook.open(path, identity)
    const account = reloaded.get(A)!
    expect(account.address).toBe(first.address)
    expect(algosdk.mnemonicToSecretKey(account.mnemonic).addr.toString()).toBe(first.address)
    expect(account.votingPower).toHaveLength(2)
    expect(account.note).toContain('Core governor: 10 of 60 committee votes')
    expect(account.note).toContain('5 of 50 AlgoQuarters in "Reti #4" (reti)')
    expect(account.note).toContain(`Replaces ${A} (app escrow of app 1001)`)
    expect(JSON.parse(readFileSync(path, 'utf-8')).accounts).toHaveLength(1)
  })

  it('refuses a file written for other registries', () => {
    SubstitutionBook.open(path, identity).getOrCreate(A, 'tinyman-pool')
    expect(() => SubstitutionBook.open(path, { ...identity, fracRegistryAppId: 9 })).toThrow(/move it away/)
  })

  it('rewrites the committee with the same votes, sorted, and reproducibly', () => {
    const book = SubstitutionBook.open(path, identity)
    book.getOrCreate(B, 'app-escrow')
    const rewritten = rewriteCommittee(committee(), book.addressMap())
    expect(rewritten.totalVotes).toBe(60)
    expect(rewritten.govs.map((g) => g.votes).reduce((s, v) => s + v, 0)).toBe(60)
    expect(rewritten.govs.map((g) => g.address)).toEqual([...rewritten.govs.map((g) => g.address)].sort())
    expect(rewritten.govs.find((g) => g.votes === 20)!.address).toBe(book.get(B)!.address)
    expect(rewritten.govs.some((g) => g.address === B)).toBe(false)
    expect(rewriteCommittee(committee(), SubstitutionBook.open(path, identity).addressMap())).toEqual(rewritten)
  })
})
