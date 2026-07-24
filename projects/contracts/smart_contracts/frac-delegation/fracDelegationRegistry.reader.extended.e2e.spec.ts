import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { getApplicationAddress } from 'algosdk'
import { deployFracInstance } from '../common-tests'
import { configureTestLogging } from '../test-utils'

/**
 * OPT-IN, slow extended coverage for the registry's paged cross-instance readers
 * (`getAccountInstanceAQs` / `getAccountVotingRecords`).
 *
 * The unit-speed spec (`fracDelegationRegistry.reader.e2e.spec.ts`) forces a tiny page size to walk
 * the paging loop with only a handful of instances. That never exercises the real constraint. These
 * tests instead spawn enough live instances to fill — and spill one past — a full PRODUCTION page,
 * which is the only way to empirically confirm the page-size math in the reader SDK: that a single
 * readonly `simulate` app call can fan out inner calls to that many instance apps (foreign apps) plus
 * their boxes within simulate's ~128 unnamed-reference budget. If a full page were over budget, that
 * page's `simulate` call would throw instead of returning, and the test would fail.
 *
 * Full-page reference cost (worst case — unsynced committees / unvoted periods still probe every box):
 *   - getAccountInstanceAQs:  1 account box + 25 × (instances box + instance app + 3 instance boxes)
 *                             = 1 + 25 × 5 = 126 references.
 *   - getAccountVotingRecords: 1 account box + 42 × (instances box + instance app + 1 instance box)
 *                             = 1 + 42 × 3 = 127 references.
 *
 * Each instance is a real spawn (a 1-ALGO MBR payment + inner app creation), so this is minutes-slow
 * and gated behind RUN_EXTENDED_E2E. Run with:
 *   RUN_EXTENDED_E2E=1 pnpm test fracDelegationRegistry.reader.extended
 */
const RUN_EXTENDED = ['1', 'true', 'yes'].includes((process.env.RUN_EXTENDED_E2E ?? '').toLowerCase())

describe.runIf(RUN_EXTENDED)('FracDelegationRegistry paged readers (extended, production page sizes)', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  /** Generate `count` fresh (unfunded) addresses; they only need to exist as arguments. */
  const freshAddresses = async (count: number): Promise<string[]> => {
    const { generateAccount } = await import('algosdk')
    return Array.from({ length: count }, () => generateAccount().addr.toString())
  }

  /**
   * Deploy a registry, spawn `pageSize + 1` instances on it (one full production page plus a
   * one-instance spill), and register a single fresh account against every one — the account's
   * `instanceNumIds` come back in creation order. `which` selects the reader whose production page
   * size to straddle; the size is read off the SDK so this auto-tracks the constants under test.
   *
   * Funds the writer generously up front (each instance costs a 1-ALGO MBR payment) and tops up the
   * registry app so the account box's MBR can grow one entry per instance.
   */
  const fillOnePagePlusOne = async (localnet: AlgorandFixture, which: 'aq' | 'votingRecords') => {
    const { testAccount } = localnet.context
    // The writer fronts a 1-ALGO MBR payment per instance (plus fees); fund it well past the ~50
    // instances any page needs, and enough to also seed the registry app below.
    await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (250).algos())

    const { sdk, instanceId } = await deployFracInstance(localnet, testAccount, { name: 'instance-1' })
    const registrySdk = sdk.registry
    // The registry app is the creator of each spawned instance app, so its own min balance climbs
    // with every spawn (creator page cost + the `instances` box) faster than the forwarded 1-ALGO
    // MBR covers. Seed it generously so a long run of spawns never drains it below min balance.
    await localnet.algorand.send.payment({
      sender: testAccount,
      receiver: getApplicationAddress(registrySdk.appId),
      amount: (100).algos(),
    })

    const pageSize = which === 'aq' ? registrySdk.aqPageSize : registrySdk.votingRecordsPageSize
    const total = pageSize + 1

    const instanceIds = [instanceId]
    for (let i = 2; i <= total; i++) {
      const { instanceId: next } = await deployFracInstance(localnet, testAccount, {
        registrySdk,
        name: `instance-${i}`,
      })
      instanceIds.push(next)
    }

    const [account] = await freshAddresses(1)
    for (const id of instanceIds) {
      // getOrCreateAccountWithInstance box_put's the account's growing `instanceNumIds` list, which
      // outgrows one app call's 700-opcode budget past ~25 entries; opup enough budget (each itxn
      // adds ~700) to cover the largest write on the last few registrations.
      await registrySdk
        .writeClient!.newGroup()
        .increaseBudget({ args: { itxns: 6 }, extraFee: (6000).microAlgo() })
        .getOrCreateAccountWithInstance({ args: { account, instanceNumId: id } })
        .send({ populateAppCallResources: true })
    }

    return { registrySdk, account, instanceIds, pageSize }
  }

  test('getAccountInstanceAQs simulates a full production AQ page and spills the extra, order preserved', async () => {
    const { registrySdk, account, instanceIds, pageSize } = await fillOnePagePlusOne(localnet, 'aq')

    const results = await registrySdk.getAccountInstanceAQs(account, new Uint8Array(32))

    // The first page carries the full `pageSize` instances in a single simulate call (its worst-case
    // reference budget); the (pageSize + 1)th spills to a second page. Aggregated order must hold.
    expect(results).toHaveLength(pageSize + 1)
    expect(results.map((r) => r.instanceNumId)).toEqual(instanceIds.map((id) => Number(id)))
    // Shape spot-check at the page boundary: an unsynced committee zeroes across it.
    for (const idx of [0, pageSize]) {
      expect(results[idx]).toMatchObject({ committeeNumId: 0, userAq: 0, totalAq: 0 })
    }
  }, 600_000)

  test('getAccountVotingRecords simulates a full production page and spills the extra, order preserved', async () => {
    const { registrySdk, account, instanceIds, pageSize } = await fillOnePagePlusOne(localnet, 'votingRecords')

    const results = await registrySdk.getAccountVotingRecords(account, 1)

    expect(results).toHaveLength(pageSize + 1)
    expect(results.map((r) => r.instanceNumId)).toEqual(instanceIds.map((id) => Number(id)))
    // No vote record for the period on any instance: empty topicVotes across the page boundary.
    for (const idx of [0, pageSize]) {
      expect(results[idx].topicVotes).toEqual([])
    }
  }, 600_000)
})
