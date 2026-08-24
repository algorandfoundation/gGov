/** Self-consistency checks for the committed escrow resolution cache, snapshots/xalgo/beneficiaries.json. */

import { describe, it, expect } from 'vitest'

import { isValidAddress } from 'algosdk'

import { createBeneficiaryStore } from '../../src/plugins/xalgo/beneficiaries.ts'
import { FOLKS_ESCROW_APP_BY_ID, XALGO_POOL_ADDRESS } from '../../src/plugins/xalgo/constants.ts'
import { createXalgoSnapshotStore } from '../../src/plugins/xalgo/snapshot.ts'

const store = createBeneficiaryStore(createXalgoSnapshotStore().beneficiariesPath)

describe.skipIf(!store.exists())('beneficiaries.json', () => {
  const { entries } = store.read()

  it('entries are strictly ascending by address, unique, and valid addresses', () => {
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) expect(entries[i - 1].address < entries[i].address).toBe(true)
      expect(isValidAddress(entries[i].address)).toBe(true)
      expect(entries[i].address).not.toBe(XALGO_POOL_ADDRESS)
    }
  })

  it('escrow entries name a tracked app, a valid owner distinct from the escrow, and an opt-in round', () => {
    for (const entry of entries) {
      if (entry.kind !== 'escrow') {
        expect(entry.kind).toBe('self')
        continue
      }
      expect(FOLKS_ESCROW_APP_BY_ID.has(BigInt(entry.app))).toBe(true)
      expect(isValidAddress(entry.owner)).toBe(true)
      expect(entry.owner).not.toBe(entry.address)
      expect(Number.isSafeInteger(entry.optInRound) && entry.optInRound > 0).toBe(true)
    }
  })

  it('is mostly escrows: fxALGO sits in Folks escrows, not wallets', () => {
    const escrows = entries.filter((entry) => entry.kind === 'escrow').length
    expect(escrows * 2 > entries.length).toBe(true)
  })
})
