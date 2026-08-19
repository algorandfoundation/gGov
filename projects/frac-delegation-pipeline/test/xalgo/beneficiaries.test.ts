/**
 * Escrow → owner resolution against a fake Indexer: open escrows from local state, closed ones from
 * the creation note in their opt-in round, everything else to itself.
 */

import { describe, it, expect } from 'vitest'

import { type Indexer, decodeAddress, generateAccount } from 'algosdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  beneficiaryOf,
  createBeneficiaryStore,
  escrowCreationNote,
  escrowLikeWarnings,
  resolveBeneficiaries,
  resolveBeneficiary,
} from '../../src/plugins/xalgo/beneficiaries.ts'
import { FOLKS_ESCROW_APPS, FOLKS_UNTRACKED_LOAN_APPS, XALGO_POOL_ADDRESS } from '../../src/plugins/xalgo/constants.ts'
import type { BeneficiaryMap } from '../../src/plugins/xalgo/types.ts'

const [ALGO_EFFICIENCY, GENERAL, DEPOSITS] = FOLKS_ESCROW_APPS
const addr = () => generateAccount().addr.toString()
const OWNER = addr()
const OTHER = addr()
const ESCROW_OPEN = addr()
const ESCROW_CLOSED = addr()
const ESCROW_DEPOSIT = addr()
const WALLET = addr()
const REKEYED = addr()
const UNTRACKED_APP_ADDR = addr()

const bytesKey = (key: string, address: string) => ({
  key: new TextEncoder().encode(key),
  value: { type: 1, bytes: decodeAddress(address).publicKey, uint: 0n },
})
const uintKey = (key: string, value: bigint) => ({
  key: new TextEncoder().encode(key),
  value: { type: 2, bytes: new Uint8Array(), uint: value },
})

/** What `lookupAccountByID(...).includeAll(true)` answers, per address. */
const ACCOUNTS: Record<string, object> = {
  [ESCROW_OPEN]: {
    address: ESCROW_OPEN,
    authAddr: ALGO_EFFICIENCY.address,
    appsLocalState: [
      { id: ALGO_EFFICIENCY.appId, optedInAtRound: 1_000n, keyValue: [uintKey('i', 3n), bytesKey('u', OWNER)] },
    ],
  },
  [ESCROW_CLOSED]: {
    address: ESCROW_CLOSED,
    appsLocalState: [{ id: GENERAL.appId, deleted: true, optedInAtRound: 2_000n, closedOutAtRound: 3_000n }],
  },
  [ESCROW_DEPOSIT]: {
    address: ESCROW_DEPOSIT,
    authAddr: DEPOSITS.address,
    appsLocalState: [{ id: DEPOSITS.appId, optedInAtRound: 4_000n, keyValue: [bytesKey('ua', OWNER)] }],
  },
  [WALLET]: { address: WALLET, appsLocalState: [{ id: 1_002_541_853n, optedInAtRound: 5n, keyValue: [] }] },
  [REKEYED]: {
    address: REKEYED,
    authAddr: UNTRACKED_APP_ADDR,
    appsLocalState: [{ id: 99n, optedInAtRound: 6n, keyValue: [bytesKey('u', OTHER)] }],
  },
}

/** What the single-round note search answers: the creation pay of the closed escrow, as an inner txn. */
const CREATION_TXNS: Record<string, object[]> = {
  [`${2_000}:${Buffer.from(escrowCreationNote(ESCROW_CLOSED, GENERAL)).toString('hex')}`]: [
    {
      sender: OTHER,
      innerTxns: [
        {
          sender: OWNER,
          note: escrowCreationNote(ESCROW_CLOSED, GENERAL),
          paymentTransaction: { receiver: GENERAL.address, amount: 0n },
        },
        // same note, wrong receiver: not a creation
        {
          sender: OTHER,
          note: escrowCreationNote(ESCROW_CLOSED, GENERAL),
          paymentTransaction: { receiver: OTHER, amount: 0n },
        },
      ],
    },
  ],
}

function fakeIndexer(): Indexer {
  const lookupAccountByID = (address: string) => {
    const builder = {
      includeAll: () => builder,
      exclude: () => builder,
      do: async () => {
        const account = ACCOUNTS[address]
        if (!account) throw new Error(`fake indexer: unknown account ${address}`)
        return { account, currentRound: 1n }
      },
    }
    return builder
  }
  const searchForTransactions = () => {
    let minRound = 0n
    let note = ''
    const builder = {
      minRound: (r: bigint) => ((minRound = r), builder),
      maxRound: () => builder,
      txType: () => builder,
      notePrefix: (n: Uint8Array) => ((note = Buffer.from(n).toString('hex')), builder),
      do: async () => ({ transactions: CREATION_TXNS[`${minRound}:${note}`] ?? [], currentRound: 1n }),
    }
    return builder
  }
  return { lookupAccountByID, searchForTransactions } as unknown as Indexer
}

describe('resolveBeneficiary', () => {
  const indexer = fakeIndexer()

  it('open loan escrow (local state with key u) → escrow of its owner, with its custody facts', async () => {
    await expect(resolveBeneficiary(indexer, ESCROW_OPEN)).resolves.toEqual({
      beneficiary: { kind: 'escrow', owner: OWNER, app: Number(ALGO_EFFICIENCY.appId), optInRound: 1_000 },
      authAddr: ALGO_EFFICIENCY.address,
      localStateApps: [ALGO_EFFICIENCY.appId],
    })
  })

  it('open deposit escrow (key ua) → owner from ua', async () => {
    const { beneficiary } = await resolveBeneficiary(indexer, ESCROW_DEPOSIT)
    expect(beneficiary).toEqual({ kind: 'escrow', owner: OWNER, app: Number(DEPOSITS.appId), optInRound: 4_000 })
  })

  it('closed escrow (deleted local state) → owner from the creation note payment at optedInAtRound, inner txns included', async () => {
    const { beneficiary } = await resolveBeneficiary(indexer, ESCROW_CLOSED)
    expect(beneficiary).toEqual({ kind: 'escrow', owner: OWNER, app: Number(GENERAL.appId), optInRound: 2_000 })
  })

  it('closed escrow with no creation note in that round → throws, never guesses', async () => {
    const orphan = addr()
    ACCOUNTS[orphan] = {
      address: orphan,
      appsLocalState: [{ id: GENERAL.appId, deleted: true, optedInAtRound: 9_999n }],
    }
    await expect(resolveBeneficiary(indexer, orphan)).rejects.toThrow(/no creation note payment/)
  })

  it('plain wallet → self', async () => {
    await expect(resolveBeneficiary(indexer, WALLET)).resolves.toEqual({
      beneficiary: { kind: 'self' },
      authAddr: undefined,
      localStateApps: [1_002_541_853n],
    })
  })

  it('address rekeyed to an untracked app with local state → self, custody reported for the factory check', async () => {
    const { beneficiary, authAddr, localStateApps } = await resolveBeneficiary(indexer, REKEYED)
    expect(beneficiary).toEqual({ kind: 'self' })
    expect(authAddr).toBe(UNTRACKED_APP_ADDR)
    expect(localStateApps).toEqual([99n])
  })
})

describe('escrowLikeWarnings', () => {
  const FACTORY = addr()
  const holder = (authAddr: string | undefined, ...apps: bigint[]) => ({
    address: addr(),
    authAddr,
    localStateApps: apps,
  })

  it('stays quiet for unrekeyed holders and for a wallet rekeyed 1:1 to a cold key', () => {
    expect(escrowLikeWarnings([holder(undefined, 1n, 2n), holder(addr(), 1n, 2n, 3n), holder(addr())])).toEqual([])
  })

  it('flags several holders rekeyed to one address, naming the apps they share', () => {
    const warnings = escrowLikeWarnings([holder(FACTORY, 7n, 8n), holder(FACTORY, 8n, 9n), holder(addr(), 8n)])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2 fxALGO holders rekeyed to ' + FACTORY)
    expect(warnings[0]).toContain('app(s) 8')
    expect(warnings[0]).not.toContain('app(s) 7')
  })

  it('flags even a single holder rekeyed to another Folks loan app', () => {
    const [ultraswapUp] = [...FOLKS_UNTRACKED_LOAN_APPS].find(([, label]) => label.startsWith('loan ULTRASWAP_UP'))!
    const warnings = escrowLikeWarnings([holder(ultraswapUp, 1_202_382_736n)])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/ULTRASWAP_UP.*add it to FOLKS_ESCROW_APPS/)
  })
})

describe('resolveBeneficiaries', () => {
  it('skips the pool and addresses already in the cache, adds the rest, and reports escrow-like groups', async () => {
    const cache: BeneficiaryMap = new Map([[ESCROW_OPEN, { kind: 'escrow', owner: 'STALE', app: 1, optInRound: 1 }]])
    const rekeyedTwin = addr()
    ACCOUNTS[rekeyedTwin] = {
      address: rekeyedTwin,
      authAddr: UNTRACKED_APP_ADDR,
      appsLocalState: [{ id: 99n, optedInAtRound: 7n, keyValue: [] }],
    }
    const { added, warnings } = await resolveBeneficiaries(
      fakeIndexer(),
      [XALGO_POOL_ADDRESS, ESCROW_OPEN, WALLET, REKEYED, rekeyedTwin, WALLET],
      cache,
    )
    expect(added.sort()).toEqual([WALLET, REKEYED, rekeyedTwin].sort())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`2 fxALGO holders rekeyed to ${UNTRACKED_APP_ADDR}`)
    expect(cache.get(ESCROW_OPEN)).toEqual({ kind: 'escrow', owner: 'STALE', app: 1, optInRound: 1 }) // untouched
    expect(cache.get(WALLET)).toEqual({ kind: 'self' })
    expect(cache.has(XALGO_POOL_ADDRESS)).toBe(false)
  })
})

describe('beneficiaryOf', () => {
  it('returns the owner for an escrow and the address itself otherwise', () => {
    const map: BeneficiaryMap = new Map([
      [ESCROW_OPEN, { kind: 'escrow', owner: OWNER, app: 1, optInRound: 1 }],
      [WALLET, { kind: 'self' }],
    ])
    expect(beneficiaryOf(map, ESCROW_OPEN)).toBe(OWNER)
    expect(beneficiaryOf(map, WALLET)).toBe(WALLET)
    expect(beneficiaryOf(map, 'UNKNOWN')).toBe('UNKNOWN')
  })
})

describe('createBeneficiaryStore', () => {
  it('round-trips a map through the file with entries sorted by address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xalgo-beneficiaries-'))
    try {
      const store = createBeneficiaryStore(join(dir, 'beneficiaries.json'))
      expect(store.exists()).toBe(false)
      expect(store.readMap()).toEqual(new Map())

      const map: BeneficiaryMap = new Map([
        ['ZZZ', { kind: 'self' }],
        ['AAA', { kind: 'escrow', owner: OWNER, app: 971389489, optInRound: 12 }],
      ])
      store.write(store.fromMap(map))
      expect(store.exists()).toBe(true)
      expect(store.read().entries.map((e) => e.address)).toEqual(['AAA', 'ZZZ'])
      expect(store.readMap()).toEqual(map)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
