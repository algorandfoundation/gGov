import { Account, Uint64 } from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import {
  errAccountAqExists,
  errAqNotStarted,
  errRegistryMissing,
  errTotalAqExceeded,
  errTotalGovsExceeded,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'
import { FracDelegationRegistryContract } from './fracDelegationRegistry.algo'

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for FracDelegationInstance.ingestAq (algorand-typescript-testing).
//
// WHAT ingestAq DOES
//   ingestAq(committeeNumId, accountAqs: (address,uint32)[]) writes one `accountAq` box per
//   [accountId, committeeNumId] and accumulates the committee's `ingestedAq` / `numAccounts`. It
//   resolves each address to its frac-registry account ID by an INNER CALL to the registry's
//   getOrCreateAccountWithInstance (mint-on-first-sight + link the account to this instance).
//
//   Body, in order:
//     1. ensureCallerIsOperator()                       — operator override, else registry fallback
//     2. resolveRegistryApp()                           — registryApp must be > 0
//     3. ensure(committeeAq(numId).exists)              — ledger must be open        [errAqNotStarted]
//     4. for (row of clone(accountAqs)) {               — ← clone of the input array
//          a. ensure(row.aq > 0)                        — reject zero-AQ rows        [errZeroAq]
//          b. registry.getOrCreateAccountWithInstance() — INNER CALL → accountId
//          c. ensure(!accountAq[id,numId].exists)       — write-once per account     [errAccountAqExists]
//          d. write box, sumAq += row.aq }
//     5. ensure(ingestedAq + sumAq <= totalAq)          — AQ overflow guard          [errTotalAqExceeded]
//     6. ensure(numAccounts + rows <= totalAccounts)    — account-count guard        [errTotalGovsExceeded]
//     7. write ingestedAq / numAccounts back
//
// UNIT-TESTABILITY BOUNDARY (what runs here vs end-to-end)
//   The ingestion loop crosses into the registry: step 4b inner-calls getOrCreateAccountWithInstance
//   to resolve/mint each account's numeric id. On the 1.2.0 testing lib that inner call is stubbed
//   with an `ApplicationSpy` (ctx.addApplicationSpy), which answers it with a chosen accountId — so
//   the caller-side ingestion logic (one box per account, the running ingestedAq/numAccounts tallies,
//   and every guard: zero-AQ, write-once, the two overflow guards) is unit-testable here.
//   (On the old 1.1.0 stable lib none of this ran: it could neither clone the Account-bearing batch
//   nor decode the registry's FracInstance { appId: Application } inside the inner call, so the whole
//   loop was e2e-only. The 1.2.0 upgrade fixes both barriers.)
//   What a return-value stub cannot model stays covered end-to-end in
//   fracDelegationInstance.algoquarters.e2e.spec.ts (localnet, real registry): the registry's OWN
//   state — an address minted a NEW id vs an already-registered address keeping its id, and the
//   per-instance numAccounts link.
// ─────────────────────────────────────────────────────────────────────────────

/** Committee numeric ID used throughout; arbitrary, only its box presence matters. */
const NUM = u16(5)

/**
 * Create the instance contract with a deterministic operator so auth never falls through to the
 * registry: `resolveOperator` returns the local `operator` override when it is non-zero, so setting
 * it here keeps every guard test independent of any registry global state.
 *
 * `registryApp` defaults to a live (empty) app id so `resolveRegistryApp` passes; pass
 * `{ registryApp: 0 }` to exercise the errRegistryMissing branch. The app is never actually called
 * in the runnable tests (they use empty batches, so the loop body never runs), so an empty app ref
 * is enough.
 */
const setup = (ctx: TestExecutionContext, opts: { registryApp?: number } = {}) => {
  const contract = ctx.contract.create(FracDelegationInstanceContract)
  const operator = ctx.any.account()
  contract.operator.value = operator
  contract.instanceNumId.value = u16(1)
  contract.registryApp.value = opts.registryApp === 0 ? Uint64(0) : ctx.any.application().id
  ctx.defaultSender = operator
  return { contract, operator }
}

/** Open a pristine ledger for NUM by seeding the box directly (FracCommitteeAq is all arc4). */
const seedLedger = (contract: FracDelegationInstanceContract, totalAq = 1000, totalAccounts = 1000): void => {
  contract.committeeAq(NUM).value = {
    totalAq: u32(totalAq),
    ingestedAq: u32(0),
    totalAccounts: u32(totalAccounts),
    numAccounts: u32(0),
  }
}

/** Hex of a bytes-like value; keys the id lookup by account. Matches the inner call's `appArgs(1)`. */
const hexOf = (bytesLike: unknown): string => Buffer.from(bytesLike as Uint8Array).toString('hex')

/** Build a (account → numeric id) lookup for the getOrCreateAccountWithInstance stub. */
const idMap = (...pairs: [Account, Uint32][]): Map<string, Uint32> =>
  new Map(pairs.map(([account, id]) => [hexOf(account.bytes), id]))

/**
 * Stub the registry's `getOrCreateAccountWithInstance` inner call: resolve each mapped account to its
 * numeric id. The real method mints an id on first sight and links the account to the instance;
 * neither registry-side effect is modelled by the stub (those are covered end-to-end), but the id it
 * returns is exactly what `ingestAq` keys its `accountAq` box by.
 */
const stubGetOrCreate = (ctx: TestExecutionContext, idByAccount: ReadonlyMap<string, Uint32>): void => {
  const spy = new ApplicationSpy(FracDelegationRegistryContract)
  spy.on.getOrCreateAccountWithInstance((itxn) => {
    const requested = hexOf((itxn as unknown as { appArgs(index: number): unknown }).appArgs(1))
    itxn.setReturnValue({ accountId: idByAccount.get(requested) ?? u32(0), instanceNumIds: [] })
  })
  ctx.addApplicationSpy(spy)
}

describe('[fast] FracDelegationInstance.ingestAq', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  // Guards that fire before ingestAq enters its (Account-bearing, un-cloneable) loop. Exercised with
  // empty batches, so they run green on 1.1.0.
  describe('guards (before the ingestion loop)', () => {
    // Scenario: a caller who is not the resolved operator is rejected up front (step 1), before any
    // state is read. Batch contents are irrelevant — an empty batch keeps this on the runnable side.
    it('rejects a non-operator caller', () => {
      const { contract } = setup(ctx)
      ctx.defaultSender = ctx.any.account() // not the operator override

      expectArc65Error(ctx, () => contract.ingestAq(NUM, []), errUnauthorized)
    })

    // Scenario: the operator passes, but the instance has no registry bound (registryApp == 0), so
    // resolveRegistryApp (step 2) fails — a batch could never resolve account IDs without it.
    it('rejects when no registry is configured', () => {
      const { contract } = setup(ctx, { registryApp: 0 })

      expectArc65Error(ctx, () => contract.ingestAq(NUM, []), errRegistryMissing)
    })

    // Scenario: operator + registry are fine, but startAqIngest was never run for this committee, so
    // its committeeAq box is absent (step 3). Checked before the loop, so a wrong committeeNumId
    // fails for free rather than after minting account IDs for the whole batch.
    it('rejects when the ledger was never started', () => {
      const { contract } = setup(ctx) // committeeAq(NUM) intentionally not seeded

      expectArc65Error(ctx, () => contract.ingestAq(NUM, []), errAqNotStarted)
    })

    // Scenario: an empty batch never enters the loop, so it clones nothing and makes no inner call —
    // the one success path fully runnable on 1.1.0. It confirms the non-loop scaffolding (auth,
    // registry resolve, ledger read, overflow guard with sumAq == 0, counter write-back) is sound.
    // (The SDK's ingestAq rejects empty batches client-side; this reaches the contract directly.)
    it('accepts an empty batch as a no-op, leaving the ledger unchanged', () => {
      const { contract } = setup(ctx)
      seedLedger(contract, 1000, 500)

      contract.ingestAq(NUM, [])

      const ledger = contract.committeeAq(NUM).value
      expect(ledger.totalAq.asUint64()).toEqual(u32(1000).asUint64())
      expect(ledger.ingestedAq.asUint64()).toEqual(u32(0).asUint64())
      // An empty batch (rows == 0) passes the account-count guard (0 <= totalAccounts) and leaves
      // both the declared total and the running tally untouched.
      expect(ledger.totalAccounts.asUint64()).toEqual(u32(500).asUint64())
      expect(ledger.numAccounts.asUint64()).toEqual(u32(0).asUint64())
    })
  })

  // logAccountAqs takes only arc4 value types (Uint16, Uint32[]), so unlike the ingestion loop it
  // clears the 1.1.0 reference-type barrier and is fully unit-testable with directly seeded boxes.
  describe('logAccountAqs', () => {
    /** Decode the 4-byte big-endian Uint32 log lines of the last executed group's first txn. */
    const loggedUint32s = (): number[] => {
      const { appLogs } = ctx.txn.lastGroup.transactions[0] as unknown as { appLogs?: { bytes: string }[] }
      return (appLogs ?? []).map((entry) => Buffer.from(entry.bytes, 'hex').readUInt32BE(0))
    }

    it('logs each account AQ in input order, 0 for accounts without an entry', () => {
      const { contract } = setup(ctx)
      // Routed (readonly) methods refuse to run while the app is still "creating".
      contract.createApplication(u16(1), 'test')
      contract.accountAq([u32(1), NUM]).value = u32(100)
      contract.accountAq([u32(3), NUM]).value = u32(250)
      // Same account in another committee must not leak into this committee's lines.
      contract.accountAq([u32(2), u16(9)]).value = u32(999)

      contract.logAccountAqs(NUM, [u32(1), u32(2), u32(3), u32(7)])

      expect(loggedUint32s()).toEqual([100, 0, 250, 0])
    })

    it('logs nothing for an empty id list', () => {
      const { contract } = setup(ctx)
      contract.createApplication(u16(1), 'test')
      contract.accountAq([u32(1), NUM]).value = u32(100)

      contract.logAccountAqs(NUM, [])

      expect(loggedUint32s()).toEqual([])
    })
  })

  // Ingestion path (steps 4a-6). The registry inner call is stubbed, so these exercise the
  // caller-side box writes, tallies, and guards. The registry-side effects — minting a NEW id vs
  // reusing an already-registered account's id, and the per-instance link — are not modelled by a
  // return-value stub and are covered in fracDelegationInstance.algoquarters.e2e.spec.ts.
  describe('ingestion', () => {
    // Scenario: a two-account batch writes one accountAq box per resolved id and rolls the sums into
    // the ledger — ingestedAq += Σ aq, numAccounts += rows.
    it('writes one accountAq box per account and accumulates ingestedAq / numAccounts', () => {
      const { contract } = setup(ctx)
      seedLedger(contract, 1000, 500)
      const a = ctx.any.account()
      const b = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(11)], [b, u32(22)]))

      contract.ingestAq(NUM, [
        { account: a, aq: u32(100) },
        { account: b, aq: u32(250) },
      ])

      expect(contract.accountAq([u32(11), NUM]).value.asUint64()).toEqual(u32(100).asUint64())
      expect(contract.accountAq([u32(22), NUM]).value.asUint64()).toEqual(u32(250).asUint64())
      const ledger = contract.committeeAq(NUM).value
      expect(ledger.ingestedAq.asUint64()).toEqual(u32(350).asUint64())
      expect(ledger.numAccounts.asUint64()).toEqual(u32(2).asUint64())
    })

    // Scenario: a zero-AQ row is rejected at step 4a — the pipeline floors sub-1-AQ accounts out, so
    // a zero here is bad input and must not cost a box.
    it('rejects a zero-AQ row with errZeroAq', () => {
      const { contract } = setup(ctx)
      seedLedger(contract)
      const a = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(1)]))

      expectArc65Error(ctx, () => contract.ingestAq(NUM, [{ account: a, aq: u32(0) }]), errZeroAq)
    })

    // Scenario: write-once per [account, committee] (step 4c). An account whose box already exists for
    // this committee is rejected — ingestedAq can never double-count.
    it('rejects re-ingesting an account already ingested for this committee, with errAccountAqExists', () => {
      const { contract } = setup(ctx)
      seedLedger(contract)
      const a = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(5)]))
      contract.accountAq([u32(5), NUM]).value = u32(100) // already ingested

      expectArc65Error(ctx, () => contract.ingestAq(NUM, [{ account: a, aq: u32(100) }]), errAccountAqExists)
    })

    // Scenario: the AQ overflow guard (step 5). A batch whose Σ aq would push ingestedAq past totalAq
    // is rejected (60 + 60 > 100).
    it('rejects a batch whose AlgoQuarters would exceed totalAq, with errTotalAqExceeded', () => {
      const { contract } = setup(ctx)
      seedLedger(contract, 100, 500) // totalAq 100
      const a = ctx.any.account()
      const b = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(1)], [b, u32(2)]))

      expectArc65Error(
        ctx,
        () =>
          contract.ingestAq(NUM, [
            { account: a, aq: u32(60) },
            { account: b, aq: u32(60) },
          ]),
        errTotalAqExceeded,
      )
    })

    // Scenario: the account-count guard (step 6). A batch whose row count would push numAccounts past
    // totalAccounts is rejected even when its Σ aq still fits under totalAq — the two totals are
    // checked independently.
    it('rejects a batch whose account count would exceed totalAccounts, with errTotalGovsExceeded', () => {
      const { contract } = setup(ctx)
      seedLedger(contract, 1000, 1) // totalAccounts 1
      const a = ctx.any.account()
      const b = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(1)], [b, u32(2)]))

      expectArc65Error(
        ctx,
        () =>
          contract.ingestAq(NUM, [
            { account: a, aq: u32(10) },
            { account: b, aq: u32(10) },
          ]),
        errTotalGovsExceeded,
      )
    })

    // Scenario: successive batches accumulate — ingestedAq/numAccounts sum across calls.
    it('accumulates ingestedAq / numAccounts across successive batches', () => {
      const { contract } = setup(ctx)
      seedLedger(contract, 1000, 500)
      const a = ctx.any.account()
      const b = ctx.any.account()
      stubGetOrCreate(ctx, idMap([a, u32(1)], [b, u32(2)]))

      contract.ingestAq(NUM, [{ account: a, aq: u32(100) }])
      contract.ingestAq(NUM, [{ account: b, aq: u32(250) }])

      const ledger = contract.committeeAq(NUM).value
      expect(ledger.ingestedAq.asUint64()).toEqual(u32(350).asUint64())
      expect(ledger.numAccounts.asUint64()).toEqual(u32(2).asUint64())
    })
  })
})
