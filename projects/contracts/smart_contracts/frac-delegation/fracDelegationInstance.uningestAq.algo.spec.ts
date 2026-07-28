import { Account, Uint64 } from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { StaticBytes, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errAccountAqNotExists, errAqNotStarted, errRegistryMissing, errUnauthorized } from '../base/errors.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'
import { FracDelegationRegistryContract } from './fracDelegationRegistry.algo'

/*
 * ============================================================================
 * Unit tests for FracDelegationInstance.uningestAq
 * ============================================================================
 *
 * Method under test:
 *   uningestAq(committeeNumId: Uint16, accounts: Account[]): void   // operator-gated
 *
 * What it does: removes per-account AlgoQuarters from a committee's ledger.
 * Body, in order:
 *   1. ensureCallerIsOperator()
 *   2. registryApp = resolveRegistryApp()            // assert(registryApp > 0)
 *   3. aqBox = committeeAq(committeeNumId)            // assert(aqBox.exists)
 *   4. for each account:                              // ← inner call here
 *        id = registry.getAccount(account).accountId  // inner app call (readonly)
 *        assert(accountAq[id, numId].exists)
 *        removedAq += box.value; box.delete()
 *   5. ingestedAq -= removedAq; numAccounts -= accounts.length
 *
 * ---------------------------------------------------------------------------
 * TESTING STRATEGY
 * ---------------------------------------------------------------------------
 * The first describe covers steps 1–3 — the guards that fire BEFORE the first
 * inner call, reached by seeding the instance's own global/box state directly.
 *
 * The second describe covers the per-account loop (step 4+). It depends on the
 * instance→registry `getAccount` inner call, which on the 1.2.0 testing lib is
 * stubbed with an `ApplicationSpy` (`ctx.addApplicationSpy`): the spy answers
 * the inner call with a chosen `FracRegAccount`, so the caller-side removal
 * logic — ledger rollback, box deletion, the not-ingested rejections, and the
 * drain→re-open lifecycle — is unit-testable here.
 *
 * What a return-value stub cannot model, and so stays covered end-to-end in
 * fracDelegationInstance.algoquarters.e2e.spec.ts: the registry's OWN state
 * (account IDs stay minted, instanceNumIds intact, its numAccounts untouched —
 * uningest never unwinds it), the box-MBR reclaim that is the `box.delete()`
 * payoff (min-balance, not modelled in the unit ledger), and the SDK
 * reference-slot batching/chunking math of uningestAqAll.
 *
 * Setup notes:
 *   - `operator.value` is set to a concrete account so `resolveOperator` returns
 *     it directly, instead of reading the registry's `defaultOperator` (which
 *     would itself need the registry app present).
 *   - `registryApp.value` is set > 0 so `resolveRegistryApp` passes (except in
 *     the errRegistryMissing case, which sets it to 0).
 *   - `committeeAq(numId).value` is seeded directly; FracCommitteeAq is all
 *     ARC-4 (four uint32s), so it round-trips.
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

/** Hex of a bytes-like value; keys the id lookup by account. Matches the inner call's `appArgs(1)`. */
const hexOf = (bytesLike: unknown): string => Buffer.from(bytesLike as Uint8Array).toString('hex')

/** Build a (account → numeric id) lookup for the getAccount stub. */
const idMap = (...pairs: [Account, Uint32][]): Map<string, Uint32> =>
  new Map(pairs.map(([account, id]) => [hexOf(account.bytes), id]))

/**
 * Stub the registry's readonly `getAccount` inner call: resolve each mapped account to its numeric
 * id. An account absent from the map resolves to accountId 0 — exactly what `getAccount` returns for
 * an address the registry has never seen, whose `accountAq` box never exists.
 */
const stubGetAccount = (ctx: TestExecutionContext, idByAccount: ReadonlyMap<string, Uint32>): void => {
  const spy = new ApplicationSpy(FracDelegationRegistryContract)
  spy.on.getAccount((itxn) => {
    const requested = hexOf((itxn as unknown as { appArgs(index: number): unknown }).appArgs(1))
    itxn.setReturnValue({ accountId: idByAccount.get(requested) ?? u32(0), instanceNumIds: [] })
  })
  ctx.addApplicationSpy(spy)
}

// One execution context per spec file (the testing lib allows a single active context per module).
const ctx = new TestExecutionContext()

describe('[fast] FracDelegationInstance uningestAq — pre-inner-call guards', () => {
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
})

describe('[fast] FracDelegationInstance uningestAq — removal & resolution (getAccount stubbed)', () => {
  const NUM = u16(1)

  beforeEach(() => ctx.reset())

  // Scenario: ingest 3 accounts worth 100 AQ each, then uningest 2. The two removed boxes are
  // deleted, the kept one survives, and ingestedAq/numAccounts roll back by the removed amounts.
  it('removes the given accounts and rolls back ingestedAq / numAccounts', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    contract.committeeAq(NUM).value = {
      totalAq: u32(300),
      ingestedAq: u32(300),
      totalAccounts: u32(3),
      numAccounts: u32(3),
    }
    contract.accountAq([u32(1), NUM]).value = u32(100)
    contract.accountAq([u32(2), NUM]).value = u32(100)
    contract.accountAq([u32(3), NUM]).value = u32(100)
    const a = ctx.any.account()
    const b = ctx.any.account()
    const c = ctx.any.account()
    stubGetAccount(ctx, idMap([a, u32(1)], [b, u32(2)], [c, u32(3)]))

    contract.uningestAq(NUM, [a, b])

    const ledger = contract.committeeAq(NUM).value
    expect(ledger.ingestedAq.asUint64()).toEqual(u32(100).asUint64())
    expect(ledger.numAccounts.asUint64()).toEqual(u32(1).asUint64())
    expect(contract.accountAq([u32(1), NUM]).exists).toBe(false)
    expect(contract.accountAq([u32(2), NUM]).exists).toBe(false)
    expect(contract.accountAq([u32(3), NUM]).exists).toBe(true)
    expect(contract.accountAq([u32(3), NUM]).value.asUint64()).toEqual(u32(100).asUint64())
  })

  // Scenario: removing in a different order than ingested clears the same boxes — a BoxMap deletes
  // by key, with no offset or ordering rule.
  it('is order-independent — removing in reverse clears the same boxes', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    contract.committeeAq(NUM).value = {
      totalAq: u32(300),
      ingestedAq: u32(200),
      totalAccounts: u32(3),
      numAccounts: u32(2),
    }
    contract.accountAq([u32(1), NUM]).value = u32(100)
    contract.accountAq([u32(2), NUM]).value = u32(100)
    const a = ctx.any.account()
    const b = ctx.any.account()
    stubGetAccount(ctx, idMap([a, u32(1)], [b, u32(2)]))

    contract.uningestAq(NUM, [b, a]) // reverse of ingestion order

    const ledger = contract.committeeAq(NUM).value
    expect(ledger.ingestedAq.asUint64()).toEqual(u32(0).asUint64())
    expect(ledger.numAccounts.asUint64()).toEqual(u32(0).asUint64())
    expect(contract.accountAq([u32(1), NUM]).exists).toBe(false)
    expect(contract.accountAq([u32(2), NUM]).exists).toBe(false)
  })

  // Scenario: a fresh address resolves to account ID 0 (registry never saw it), whose accountAq box
  // never exists — rejected as "not ingested" rather than mistaken for a real account.
  it('rejects an account the registry has never seen (resolves to id 0) with FA_NX', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    contract.committeeAq(NUM).value = {
      totalAq: u32(100),
      ingestedAq: u32(100),
      totalAccounts: u32(1),
      numAccounts: u32(1),
    }
    contract.accountAq([u32(1), NUM]).value = u32(100)
    const stranger = ctx.any.account()
    stubGetAccount(ctx, idMap()) // empty map → stranger resolves to id 0

    expectArc65Error(ctx, () => contract.uningestAq(NUM, [stranger]), errAccountAqNotExists)
  })

  // Scenario: getAccount returns a real id, but accountAq[id, thisCommittee] is absent — the account
  // is registered but was never ingested into THIS committee.
  it('rejects an account registered but not ingested into this committee with FA_NX', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    contract.committeeAq(NUM).value = {
      totalAq: u32(100),
      ingestedAq: u32(100),
      totalAccounts: u32(1),
      numAccounts: u32(1),
    }
    contract.accountAq([u32(1), NUM]).value = u32(100)
    const other = ctx.any.account()
    stubGetAccount(ctx, idMap([other, u32(9)])) // real id, but no accountAq[9] box

    expectArc65Error(ctx, () => contract.uningestAq(NUM, [other]), errAccountAqNotExists)
  })

  // Scenario: the same account twice in one batch — the first pass deletes its box, so the second
  // pass finds it already gone and rejects.
  it('rejects a duplicate account within one batch with FA_NX', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    contract.committeeAq(NUM).value = {
      totalAq: u32(100),
      ingestedAq: u32(100),
      totalAccounts: u32(2),
      numAccounts: u32(1),
    }
    contract.accountAq([u32(7), NUM]).value = u32(100)
    const a = ctx.any.account()
    stubGetAccount(ctx, idMap([a, u32(7)]))

    expectArc65Error(ctx, () => contract.uningestAq(NUM, [a, a]), errAccountAqNotExists)
  })

  // Scenario: after removing every account, ingestedAq === 0, so startAqIngest may re-set the total
  // (otherwise frozen by errIngestedAqNotZero) — the correction-and-lifecycle payoff of uningest.
  it('draining a ledger to zero re-opens it for a fresh startAqIngest total', () => {
    const { contract } = makeAuthorisedInstance(ctx)
    const committeeId = new StaticBytes<32>()
    contract.committees(committeeId).value = {
      committeeNumId: NUM,
      escrowsVotes: [],
      totalVotes: u32(0),
    }
    contract.committeeAq(NUM).value = {
      totalAq: u32(100),
      ingestedAq: u32(100),
      totalAccounts: u32(1),
      numAccounts: u32(1),
    }
    contract.accountAq([u32(1), NUM]).value = u32(100)
    const a = ctx.any.account()
    stubGetAccount(ctx, idMap([a, u32(1)]))

    contract.uningestAq(NUM, [a])
    expect(contract.committeeAq(NUM).value.ingestedAq.asUint64()).toEqual(u32(0).asUint64())

    // ingestedAq === 0, so a corrected total is now allowed.
    const reopened = contract.startAqIngest(committeeId, u32(250), u32(2))
    expect(reopened.totalAq.asUint64()).toEqual(u32(250).asUint64())
    expect(contract.committeeAq(NUM).value.totalAq.asUint64()).toEqual(u32(250).asUint64())
    expect(contract.committeeAq(NUM).value.ingestedAq.asUint64()).toEqual(u32(0).asUint64())
  })
})
