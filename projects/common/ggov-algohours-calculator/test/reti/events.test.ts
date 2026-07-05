/** ARC-28 log decoding for src/reti/events.ts, on synthetic indexer transactions. */

import { decodeAddress, encodeAddress, type indexerModels } from 'algosdk'
import { describe, it, expect } from 'vitest'

import {
  EPOCH_REWARD_UPDATE_SELECTOR,
  RETI_APP_ID,
  STAKE_ADDED_SELECTOR,
  STAKE_REMOVED_SELECTOR,
} from '../../src/reti/constants'
import { getRetiEventsFromTransactions } from '../../src/reti/events'

const STAKER = encodeAddress(new Uint8Array(32).fill(7))

function makeLog(selector: Buffer, length: number, fields: { staker?: string; tail: bigint[] }): Uint8Array {
  const log = Buffer.alloc(length)
  selector.copy(log, 0)
  log.writeBigUInt64BE(7n, 4) // validatorId
  log.writeUInt16BE(1, 12) // poolNum
  log.writeBigUInt64BE(101n, 14) // poolAppId
  let offset = 22
  if (fields.staker) {
    Buffer.from(decodeAddress(fields.staker).publicKey).copy(log, offset)
    offset += 32
  }
  for (const value of fields.tail) {
    log.writeBigUInt64BE(value, offset)
    offset += 8
  }
  return log
}

function makeTxn(overrides: {
  appId?: bigint
  logs?: Uint8Array[]
  inner?: ReturnType<typeof makeTxn>[]
}): indexerModels.Transaction {
  return {
    txType: 'appl',
    applicationTransaction: { applicationId: overrides.appId ?? RETI_APP_ID },
    logs: overrides.logs ?? [],
    innerTxns: overrides.inner ?? [],
    confirmedRound: 123n,
    roundTime: 456,
    intraRoundOffset: 2,
  } as unknown as indexerModels.Transaction
}

describe('getRetiEventsFromTransactions', () => {
  it('decodes a stakeAdded log with the outer transaction metadata', () => {
    const log = makeLog(STAKE_ADDED_SELECTOR, 62, { staker: STAKER, tail: [5_000_000n] })
    expect(getRetiEventsFromTransactions([makeTxn({ logs: [log] })])).toEqual([
      {
        type: 'stakeAdded',
        round: 123,
        timestamp: 456,
        intraOffset: 2,
        validatorId: 7n,
        poolAppId: 101n,
        staker: STAKER,
        amount: 5_000_000n,
      },
    ])
  })

  it('decodes a stakeRemoved log, ignoring the reward-token fields', () => {
    const log = makeLog(STAKE_REMOVED_SELECTOR, 78, { staker: STAKER, tail: [2_000_000n, 55n, 999n] })
    const [event] = getRetiEventsFromTransactions([makeTxn({ logs: [log] })])
    expect(event).toMatchObject({ type: 'stakeRemoved', staker: STAKER, amount: 2_000_000n })
  })

  it('decodes an epochRewardUpdate log, reading algoAdded past commission and burn', () => {
    const log = makeLog(EPOCH_REWARD_UPDATE_SELECTOR, 54, { tail: [11n, 22n, 33_000_000n, 44n] })
    const [event] = getRetiEventsFromTransactions([makeTxn({ logs: [log] })])
    expect(event).toMatchObject({ type: 'epochRewardUpdate', poolAppId: 101n, algoAdded: 33_000_000n })
  })

  it('collects events logged in inner registry calls', () => {
    const log = makeLog(STAKE_REMOVED_SELECTOR, 78, { staker: STAKER, tail: [2_000_000n, 0n, 0n] })
    const outer = makeTxn({ appId: 424242n, inner: [makeTxn({ logs: [log] })] })
    const [event] = getRetiEventsFromTransactions([outer])
    expect(event).toMatchObject({ type: 'stakeRemoved', round: 123, timestamp: 456 })
  })

  it('ignores logs from other apps even with a matching payload', () => {
    const log = makeLog(STAKE_ADDED_SELECTOR, 62, { staker: STAKER, tail: [5_000_000n] })
    expect(getRetiEventsFromTransactions([makeTxn({ appId: 424242n, logs: [log] })])).toEqual([])
    expect(getRetiEventsFromTransactions([makeTxn({ inner: [makeTxn({ appId: 424242n, logs: [log] })] })])).toEqual([])
  })

  it('ignores unknown selectors and wrong-length payloads', () => {
    const wrongSelector = makeLog(Buffer.from([1, 2, 3, 4]), 62, { staker: STAKER, tail: [5n] })
    const wrongLength = makeLog(STAKE_ADDED_SELECTOR, 61, { tail: [] })
    expect(getRetiEventsFromTransactions([makeTxn({ logs: [wrongSelector, wrongLength] })])).toEqual([])
  })
})
