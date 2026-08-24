import { describe, expect, test } from 'vitest'
import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AVAILABLE_SOURCES, createUninitializedPlugin } from '../src/plugins/index.ts'
import { SCAN_CONCURRENCY } from '../src/aq/config.ts'

// No plugin makes a request from its constructor, but reti builds its ghost SDK there, which asks
// the client for a typed app factory. That one call is all this stand-in has to answer: nothing
// touches the network until `init()`, which `createUninitializedPlugin` deliberately does not call.
const stubClient = {
  client: { getTypedAppFactory: () => ({ getAppClientById: () => ({}) }) },
} as unknown as AlgorandClient

/** `concurrency` is protected, and reading it is exactly what these assertions are for. */
const concurrencyOf = (plugin: object) => (plugin as unknown as { concurrency: number }).concurrency

describe('plugin construction', () => {
  // Regression: the pipeline documents `concurrency` as bounding the AlgoQuarters window scans,
  // but for a while it never reached the plugins at all — every scan ran at SCAN_CONCURRENCY no
  // matter what the caller asked for, which is precisely what a rate-limited indexer cannot take.
  test.each(AVAILABLE_SOURCES)('%s carries the concurrency it is built with', (source) => {
    expect(concurrencyOf(createUninitializedPlugin(source, stubClient, undefined, 1))).toBe(1)
    expect(concurrencyOf(createUninitializedPlugin(source, stubClient, undefined, 9))).toBe(9)
  })

  test.each(AVAILABLE_SOURCES)('%s falls back to SCAN_CONCURRENCY when built standalone', (source) => {
    expect(concurrencyOf(createUninitializedPlugin(source, stubClient))).toBe(SCAN_CONCURRENCY)
  })

  test('rejects an unknown source', () => {
    expect(() => createUninitializedPlugin('nope', stubClient)).toThrow(/Unknown staking source/)
  })
})
