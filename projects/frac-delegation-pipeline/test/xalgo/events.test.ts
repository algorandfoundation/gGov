/**
 * xALGO rate-event decoding, against logs the consensus app really emitted (mainnet), plus the
 * selectors/lengths it must reject. Byte layouts: ImmediateMint 84, Burn 52 (xALGO before ALGO),
 * ClaimDelayedMint 120.
 */

import { describe, it, expect } from 'vitest'

import {
  BURN_SELECTOR,
  CLAIM_DELAYED_MINT_SELECTOR,
  IMMEDIATE_MINT_SELECTOR,
  RATE_SCALER,
} from '../../src/plugins/xalgo/constants.ts'
import { decodeXAlgoRateEventLog, rateOfEvent } from '../../src/plugins/xalgo/indexer.ts'

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'))
const u64 = (n: bigint) => n.toString(16).padStart(16, '0')
const ROUTER_PK = '57f2bdc47fb0186a8825c8b79ede99934ec5aa7d2a2207f2822d72256ed0efe8' // K7ZL… StakeAndDeposit app account
const USER_PK = '4bc868e7c6e20391385fa57d0cd93e991ad5450f236899acdd57dea429959a4f' // JPEG…

// Ultrastake 2x of 200 ALGO, round 64215436: the router mints 400 ALGO → 327.194084 xALGO (inner call)
const ULTRA_MINT_LOG = hex(`5af2d40e ${ROUTER_PK} ${ROUTER_PK} 0000000017d78400 00000000138095e4`)
// Its unwind, round 64215568: burn 327.194083 xALGO → 400.000181 ALGO
const ULTRA_BURN_LOG = hex(`45a62f7a ${USER_PK} 00000000138095e3 0000000017d784b5`)
// Plain stake of 200 ALGO, round 64215385 → 163.597082 xALGO; unstaked at round 64215402 → 200.000015 ALGO
const PLAIN_MINT_LOG = hex(`5af2d40e ${USER_PK} ${USER_PK} 000000000bebc200 0000000009c04b1a`)
const PLAIN_BURN_LOG = hex(`45a62f7a ${USER_PK} 0000000009c04b1a 000000000bebc20f`)

describe('decodeXAlgoRateEventLog', () => {
  it('decodes ImmediateMint as (algo, xalgo)', () => {
    expect(decodeXAlgoRateEventLog(ULTRA_MINT_LOG)).toEqual({
      kind: 'ImmediateMint',
      algo: 400_000_000n,
      xalgo: 327_194_084n,
    })
    expect(decodeXAlgoRateEventLog(PLAIN_MINT_LOG)).toEqual({
      kind: 'ImmediateMint',
      algo: 200_000_000n,
      xalgo: 163_597_082n,
    })
  })

  it('decodes Burn as (xalgo, algo) — the xALGO amount comes first in the log', () => {
    expect(decodeXAlgoRateEventLog(ULTRA_BURN_LOG)).toEqual({ kind: 'Burn', xalgo: 327_194_083n, algo: 400_000_181n })
    expect(decodeXAlgoRateEventLog(PLAIN_BURN_LOG)).toEqual({ kind: 'Burn', xalgo: 163_597_082n, algo: 200_000_015n })
  })

  it('decodes ClaimDelayedMint (box name, minter, receiver, algo, xalgo)', () => {
    const log = hex(
      `${Buffer.from(CLAIM_DELAYED_MINT_SELECTOR).toString('hex')} ${'ab'.repeat(36)} ${USER_PK} ${USER_PK} ${u64(1_000_000n)} ${u64(818_000n)}`,
    )
    expect(log.length).toBe(120)
    expect(decodeXAlgoRateEventLog(log)).toEqual({ kind: 'ClaimDelayedMint', algo: 1_000_000n, xalgo: 818_000n })
  })

  it('selectors match the ARC-28 signatures', () => {
    expect(Buffer.from(IMMEDIATE_MINT_SELECTOR).toString('hex')).toBe('5af2d40e')
    expect(Buffer.from(BURN_SELECTOR).toString('hex')).toBe('45a62f7a')
    expect(Buffer.from(CLAIM_DELAYED_MINT_SELECTOR).toString('hex')).toBe('27017652')
  })

  it('returns null for other logs: unknown selector, wrong length, ABI return values', () => {
    expect(decodeXAlgoRateEventLog(hex(`151f7c75 00000000138095e3`))).toBeNull() // ABI return prefix
    expect(decodeXAlgoRateEventLog(ULTRA_MINT_LOG.slice(0, 83))).toBeNull()
    expect(
      decodeXAlgoRateEventLog(
        hex(`${Buffer.from(BURN_SELECTOR).toString('hex')} ${USER_PK} ${USER_PK} 00000000138095e3 0000000017d784b5`),
      ),
    ).toBeNull() // Burn with a mint-sized body
    expect(decodeXAlgoRateEventLog(new Uint8Array(0))).toBeNull()
  })
})

describe('rateOfEvent', () => {
  it('is algo × RATE_SCALER / xalgo, floored, for mints and burns alike', () => {
    expect(rateOfEvent(decodeXAlgoRateEventLog(ULTRA_MINT_LOG)!)).toBe(1_222_515_991_456n)
    expect(rateOfEvent(decodeXAlgoRateEventLog(ULTRA_BURN_LOG)!)).toBe(1_222_516_548_381n)
    expect(rateOfEvent(decodeXAlgoRateEventLog(PLAIN_MINT_LOG)!)).toBe(1_222_515_692_547n)
    expect(rateOfEvent(decodeXAlgoRateEventLog(PLAIN_BURN_LOG)!)).toBe(1_222_515_784_236n)
  })

  it('is monotone across the four observations, 17 and 166 rounds apart (proposer rewards only accrue)', () => {
    const rates = [PLAIN_MINT_LOG, PLAIN_BURN_LOG, ULTRA_MINT_LOG, ULTRA_BURN_LOG].map((log) =>
      rateOfEvent(decodeXAlgoRateEventLog(log)!),
    )
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1])
    for (const rate of rates) expect(rate > RATE_SCALER && rate < 2n * RATE_SCALER).toBe(true)
  })

  it('refuses an event with no xALGO amount', () => {
    expect(() => rateOfEvent({ kind: 'Burn', algo: 1n, xalgo: 0n })).toThrow(/no xALGO amount/)
  })
})
