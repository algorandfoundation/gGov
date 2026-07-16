import { Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errAqNotStarted, errNumAccountsExceeded, errRegistryMissing, errUnauthorized } from '../base/errors.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'

/*
 * ============================================================================
 * PLAN — unit tests for FracDelegationInstance.uningestAq
 * ============================================================================
 *
 * Method under test:
 *   uningestAq(committeeNumId: Uint16, accounts: Account[]): void   // operator-gated
 *
 * What it does (see UNINGEST.md): removes per-account AlgoQuarters from a
 * committee's ledger. Body, in order:
 *   1. ensureCallerIsOperator()
 *   2. registryApp = resolveRegistryApp()            // ensure(registryApp > 0)
 *   3. aqBox = committeeAq(committeeNumId)            // ensure(aqBox.exists)
 *   4. ensure(accounts.length <= numAccounts)         // cheap count guard
 *   5. for each account:                              // ← FIRST inner call here
 *        id = registry.getAccount(account).accountId  // inner app call (readonly)
 *        ensure(accountAq[id, numId].exists)
 *        removedAq += box.value; box.delete()
 *   6. ingestedAq -= removedAq; numAccounts -= accounts.length
 *
 * ---------------------------------------------------------------------------
 * TESTING STRATEGY
 * ---------------------------------------------------------------------------
 * The unit harness (@algorandfoundation/algorand-typescript-testing) runs one
 * contract in isolation. Everything in step 5+ depends on an *inner app call*
 * from the instance into the frac registry's `getAccount`, which the unit
 * context does not wire up (there is no cross-app inner call anywhere in this
 * repo's unit specs — all cross-contract behaviour is covered end-to-end).
 * Box MBR reclaim (the `box.delete()` payoff) is likewise not modelled in the
 * unit ledger. Separately, the pinned stable lib (1.1.0) cannot decode a struct
 * with a reference-type field, which is why the sibling `ingestAq` path is
 * e2e-only too (see fracDelegationRegistry.account.algo.spec.ts).
 *
 * So this file unit-tests exactly the guards in steps 1–4 — the rejections that
 * fire BEFORE the first inner call and need no registry. Each is reached by
 * seeding the instance's own global/box state directly. Everything past the
 * first `getAccount` is enumerated as scenarios in the `describe.skip` block at
 * the bottom and is covered by fracDelegationInstance.algoquarters.e2e.spec.ts.
 *
 * Setup notes:
 *   - `operator.value` is set to a concrete account so `resolveOperator` returns
 *     it directly, instead of reading the registry's `defaultOperator` (which
 *     would itself need the registry app present).
 *   - `registryApp.value` is set > 0 so `resolveRegistryApp` passes (except in
 *     the errRegistryMissing case, which sets it to 0).
 *   - `committeeAq(numId).value` is seeded directly; FracCommitteeAq is all
 *     ARC-4 (three uint32s), so it round-trips on 1.1.0.
 */

/** A bound, operator-authorised instance contract with `registryApp` set. */
const makeAuthorisedInstance = (ctx: TestExecutionContext) => {
  const operator = ctx.any.account()
  const contract = ctx.contract.create(FracDelegationInstanceContract)
  contract.operator.value = operator // resolveOperator returns this without touching the registry
  contract.registryApp.value = Uint64(5) // any non-zero app id passes resolveRegistryApp
  ctx.defaultSender = operator
  return { contract, operator }
}

describe('FracDelegationInstance uningestAq — pre-inner-call guards', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  // Scenario: a caller who is not the resolved operator is rejected at step 1,
  // before the registry is even resolved.
  it('rejects a non-operator (ERR:AUTH)', () => {
    const operator = ctx.any.account()
    const contract = ctx.contract.create(FracDelegationInstanceContract)
    contract.operator.value = operator
    contract.registryApp.value = Uint64(5)
    ctx.defaultSender = ctx.any.account() // someone other than the operator

    expectArc65Error(ctx, () => contract.uningestAq(u16(1), [ctx.any.account()]), errUnauthorized)
  })

  // Scenario: the operator calls, but no registry is bound. resolveRegistryApp
  // (step 2) rejects, so we never reach a ledger lookup or an inner call.
  it('rejects when no registry app is bound (ERR:RM)', () => {
    const operator = ctx.any.account()
    const contract = ctx.contract.create(FracDelegationInstanceContract)
    contract.operator.value = operator
    contract.registryApp.value = Uint64(0) // unbound
    ctx.defaultSender = operator

    expectArc65Error(ctx, () => contract.uningestAq(u16(1), [ctx.any.account()]), errRegistryMissing)
  })

  // Scenario: operator + registry are fine, but no ledger was ever opened for
  // this committee. The `aqBox.exists` guard (step 3) rejects a wrong/unopened
  // committeeNumId for free, before any account is resolved.
  it('rejects when the ledger was never started (ERR:FA_NS)', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    // No committeeAq(1) box seeded.

    expectArc65Error(ctx, () => contract.uningestAq(u16(1), [ctx.any.account()]), errAqNotStarted)
  })

  // Scenario: the batch is larger than the committee's ingested account count.
  // The cheap arithmetic guard (step 4) rejects before touching any box or
  // making any inner call — the same reason it is checked up front.
  it('rejects a batch larger than the ingested account count (ERR:FA_AC)', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    // A ledger holding a single ingested account.
    contract.committeeAq(u16(1)).value = { totalAq: u32(100), ingestedAq: u32(100), numAccounts: u32(1) }

    // Two accounts against numAccounts === 1.
    expectArc65Error(
      ctx,
      () => contract.uningestAq(u16(1), [ctx.any.account(), ctx.any.account()]),
      errNumAccountsExceeded,
    )
    // The guard is before any mutation: the ledger is untouched.
    expect(contract.committeeAq(u16(1)).value.numAccounts.asUint64()).toEqual(u32(1).asUint64())
  })
})

/*
 * ============================================================================
 * SCENARIOS PAST THE FIRST INNER CALL — covered by
 * fracDelegationInstance.algoquarters.e2e.spec.ts (describe → 'uningestAq' /
 * 'uningestAq rejections' / 'batching'), NOT unit-testable here.
 * ============================================================================
 *
 * Each of these enters the per-account loop, so it needs the instance→registry
 * `getAccount` inner call (and, for MBR, real min-balance accounting) that the
 * unit context does not provide. Listed here so the coverage map is complete;
 * un-skip if a future toolchain wires cross-app inner calls into the harness.
 *
 *  - removes accounts and rolls back ingestedAq / numAccounts
 *      ingest 3, uningest 2 → ledger {ingestedAq: 100, numAccounts: 1}; the two
 *      removed accounts read 0, the kept one reads its value.
 *
 *  - frees the instance box MBR it locked
 *      min-balance drops by exactly 6,900 µALGO per removed accountAq box.
 *      (Not observable in the unit ledger at all — inherently e2e.)
 *
 *  - draining to zero re-opens startAqIngest for a corrected total
 *      after removing every account, ingestedAq === 0, so startAqIngest may
 *      re-set totalAq (otherwise frozen by errIngestedAqNotZero).
 *
 *  - leaves the registry account record and instance association intact
 *      account IDs stay minted and instanceNumIds still contains the instance;
 *      the registry's numAccounts is unchanged (uningest never unwinds it).
 *
 *  - is order-independent
 *      removing in a different order than ingested clears the ledger the same
 *      way (BoxMap deletes by key — no offset, no ordering rule).
 *
 *  - resolves addresses via the registry's readonly getAccount, rejecting an
 *    account the registry has never seen (ERR:FA_NX)
 *      a fresh address resolves to account ID 0, whose accountAq box never
 *      exists.
 *
 *  - rejects an account registered but not ingested into THIS committee
 *    (ERR:FA_NX)
 *      getAccount returns a real id, but accountAq[id, thisCommittee] is absent.
 *
 *  - rejects a duplicate account within one batch, reverting the whole group
 *    (ERR:FA_NX)
 *      the second pass finds the box already deleted; the group is atomic, so
 *      nothing is removed.
 *
 *  - batching: a full MAX_ACCOUNTS_PER_UNINGEST_AQ uningest lands in one group,
 *    and uningestAqAll chunks past the per-call limit (SDK reference-slot math).
 */
describe.skip('FracDelegationInstance uningestAq — removal & resolution (e2e-only, see comment above)', () => {
  it('covered by fracDelegationInstance.algoquarters.e2e.spec.ts', () => {})
})
