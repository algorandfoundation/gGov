import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { getApplicationAddress } from 'algosdk'
import { GGovCommitteeFile } from 'ggov-sdk'
import { deployFracInstance, deployRegistryWithCommittee } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
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
 * Full-page reference cost (worst case — unvoted periods still probe every box):
 *   - getAccountInstanceAQs:  1 account box + I × (instances box + instance app) + I × C × (the 3
 *                             instance boxes `getAccountCommitteeAq` reads: `committees`,
 *                             `committeeAq`, `accountAq`), for I instances over C committees:
 *
 *                                 refs(I, C) = 1 + I·(2 + 3C) ≤ 128
 *
 *                             | C  | instances/page | references |
 *                             |----|----------------|------------|
 *                             |  1 |             25 | 1 + 25×5   = 126 |
 *                             |  5 |              7 | 1 + 7×17   = 120 |
 *                             | 41 |              1 | 1 + 1×125  = 126 |
 *
 *                             C ≥ 42 fits no instance at all, which is why the committee axis has
 *                             its own cap (`aqMaxCommitteesPerCall`) and not just a page size.
 *
 *                             The committee axis only costs 3 references per pair when the
 *                             committees are actually *synced*: an unsynced one resolves
 *                             `committeeNumId` to the 0 sentinel, so `committeeAq(0)` and
 *                             `accountAq([id, 0])` are the same two boxes for every committee and
 *                             dedupe to 2 references per instance. The C > 1 tests below therefore
 *                             sync every committee on every instance — otherwise they would prove
 *                             nothing about the budget.
 *   - getAccountVotingRecords: 1 account box + 42 × (instances box + instance app + 1 instance box)
 *                             = 1 + 42 × 3 = 127 references.
 *
 * Each instance is a real spawn (a 1-ALGO MBR payment + inner app creation) and each committee is a
 * real gGov upload plus one `syncCommittee` per instance, so this is minutes-slow and gated behind
 * RUN_EXTENDED_E2E. Run with:
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

    // No `numInstances` hint, so the committee axis is sized first: C = 1 leaves the instance axis
    // the whole budget, i.e. exactly `aqPageSize`. That identity is what this test straddles.
    const results = await registrySdk.getAccountInstanceAQs(account, [new Uint8Array(32)])

    // The first page carries the full `pageSize` instances in a single simulate call (its worst-case
    // reference budget); the (pageSize + 1)th spills to a second page. Aggregated order must hold.
    expect(results).toHaveLength(pageSize + 1)
    expect(results.map((r) => r.instanceNumId)).toEqual(instanceIds.map((id) => Number(id)))
    // Shape spot-check at the page boundary: an unsynced committee zeroes across it.
    for (const idx of [0, pageSize]) {
      expect(results[idx]).toMatchObject({ committeeNumId: 0, userAq: 0, totalAq: 0, totalVotes: 0 })
    }
  }, 600_000)

  /**
   * The committee-axis fixture: `committeeCount` real gGov committees, all synced on every one of
   * `instancesPerPage(committeeCount) + 1` frac instances, with a single account registered against
   * all of them. Straddles a full page on the instance axis exactly like `fillOnePagePlusOne`, but
   * at a committee width the AQ reader now has to fit alongside it.
   *
   * The committees must be real and really synced: an unsynced committee resolves to the
   * `committeeNumId` 0 sentinel, whose `committeeAq`/`accountAq` boxes are shared by every
   * committee, so an unsynced fixture would dedupe down to ~2 references per instance and pass no
   * matter how wrong the budget arithmetic was. Distinct gGov committees are minted by shifting the
   * template's block window, which is what makes each committee id — and so each `committees` box,
   * `committeeNumId`, and pair of AQ boxes — distinct.
   */
  const fillCommitteeAxis = async (localnet: AlgorandFixture, committeeCount: number) => {
    const { testAccount } = localnet.context
    await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (250).algos())

    // One gGov registry with `committeeCount` committees. The first comes with two funded govs (the
    // escrows the instances need to be allowed to sync at all); the rest reuse the same gov, since
    // membership is irrelevant here — `tryGetGovVotingPower` reports 0 for a non-member.
    const { sdk: ggovSdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet, 2, 10)
    const committeeIds = [committeeId]
    for (let i = 1; i < committeeCount; i++) {
      const file: GGovCommitteeFile = {
        ...committeeTemplate,
        periodStart: committeeTemplate.periodStart + i * 3_000_000,
        periodEnd: committeeTemplate.periodEnd + i * 3_000_000,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: [{ address: govAccounts[0].toString(), votes: 10 }],
      }
      committeeIds.push(await ggovSdk.uploadCommitteeFile(file))
    }

    // `refs(I, C) = 1 + I·(2 + 3C) ≤ 128`, solved for I — the page this fixture straddles.
    const instancesPerPage = Math.floor(127 / (2 + 3 * committeeCount))
    const total = instancesPerPage + 1

    const first = await deployFracInstance(localnet, testAccount, { name: 'instance-1' })
    const registrySdk = first.sdk.registry
    await registrySdk.setGGovRegistryApp({ appId: ggovSdk.appId })
    await localnet.algorand.send.payment({
      sender: testAccount,
      receiver: getApplicationAddress(registrySdk.appId),
      amount: (100).algos(),
    })

    const instances = [first]
    for (let i = 2; i <= total; i++) {
      instances.push(await deployFracInstance(localnet, testAccount, { registrySdk, name: `instance-${i}` }))
    }

    // An escrow is globally unique across instances, so they cannot share one — but syncing only
    // needs *an* escrow, not a member, so a fresh address per instance past the first is enough.
    for (const [i, instance] of instances.entries()) {
      const escrow = i < govAccounts.length ? govAccounts[i]!.toString() : (await freshAddresses(1))[0]!
      await registrySdk.registerEscrow({ instanceNumId: instance.instanceId, account: escrow })
      for (const id of committeeIds) {
        await instance.sdk.syncCommittee({ instanceNumId: instance.instanceId, committeeId: id })
      }
    }

    const [account] = await freshAddresses(1)
    for (const instance of instances) {
      await registrySdk
        .writeClient!.newGroup()
        .increaseBudget({ args: { itxns: 6 }, extraFee: (6000).microAlgo() })
        .getOrCreateAccountWithInstance({ args: { account, instanceNumId: instance.instanceId } })
        .send({ populateAppCallResources: true })
    }

    return {
      registrySdk,
      account,
      committeeIds,
      instanceIds: instances.map((i) => i.instanceId),
      instancesPerPage,
    }
  }

  /**
   * Both C > 1 shapes on the reference curve: the middle (C = 5, 7 instances per page) and the
   * widest committee list that still fits an instance (C = 41, 1 per page — one more committee and
   * no page is possible at all). Each spills one instance past its page, so both the per-page budget
   * and the aggregation across pages are exercised.
   */
  test.each([
    { committeeCount: 5, refs: '1 + 7×17 = 120' },
    { committeeCount: 41, refs: '1 + 1×125 = 126' },
  ])(
    'getAccountInstanceAQs fills a page at C=$committeeCount ($refs refs) and spills the extra',
    async ({ committeeCount }) => {
      const { registrySdk, account, committeeIds, instanceIds, instancesPerPage } = await fillCommitteeAxis(
        localnet,
        committeeCount,
      )

      // No `numInstances` hint: the committee axis is sized first (all `committeeCount` fit one call,
      // since committeeCount <= aqMaxCommitteesPerCall) and the instance axis takes the remainder —
      // which is `instancesPerPage`, so the (instancesPerPage + 1)th instance spills to a second page.
      const results = await registrySdk.getAccountInstanceAQs(account, committeeIds)

      // One instance past a full page, so the aggregation across the page boundary is under test too.
      expect(instanceIds).toHaveLength(instancesPerPage + 1)
      expect(results).toHaveLength(instanceIds.length * committeeCount)
      // One row per (instance, committee) pair, instance-major, both axes in their input order.
      expect(results.map((r) => r.instanceNumId)).toEqual(
        instanceIds.flatMap((id) => Array.from({ length: committeeCount }, () => Number(id))),
      )
      for (const [i, row] of results.entries()) {
        expect(row.committeeId).toEqual(committeeIds[i % committeeCount])
        // Synced, so the committee resolved to a real numeric id — which is what made this fixture's
        // per-pair AQ boxes distinct, and the reference budget above the real one.
        expect(row.committeeNumId).toBeGreaterThan(0)
      }

      // The other half of the claim: the page above sits *at* the ceiling, not merely under it. Lie
      // about the budget so the sizer packs two instances into one call at the same committee width
      // (1 + 2×125 = 251 references) and simulate must refuse it.
      if (committeeCount === 41) {
        registrySdk.aqRefBudget = 254
        await expect(registrySdk.getAccountInstanceAQs(account, committeeIds, { numInstances: 2 })).rejects.toThrow()
      }
    },
    900_000,
  )

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
