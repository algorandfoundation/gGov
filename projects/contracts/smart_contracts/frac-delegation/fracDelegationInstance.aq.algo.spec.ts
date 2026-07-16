import { Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import {
  errAccountAqExists,
  errAqNotStarted,
  errRegistryMissing,
  errTotalAqExceeded,
  errUnauthorized,
  errZeroAq,
} from '../base/errors.algo'
import { u16, u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'

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
//     5. ensure(ingestedAq + sumAq <= totalAq)          — overflow guard             [errTotalAqExceeded]
//     6. write ingestedAq / numAccounts back
//
// UNIT-TESTABILITY BOUNDARY (why this file is split into runnable + skipped)
//   The pinned stable testing lib (@algorandfoundation/algorand-typescript-testing@1.1.0) cannot
//   clone/decode a struct carrying a reference-type field. TWO such barriers sit on the ingestion
//   path, and the first one is hit early:
//     • Step 4 opens with `clone(accountAqs)`, and AccountWithAq = { account: Account, aq }. `Account`
//       is a reference type, so 1.1.0 throws "unsupported type Account" cloning it — meaning ANY
//       NON-EMPTY batch fails at loop entry, before even the zero-AQ guard (4a).
//     • Step 4b then clone()s the registry's FracInstance { appId: Application } inside
//       getOrCreateAccountWithInstance — the same barrier the registry's own unit spec skips.
//   So what runs green on 1.1.0 is steps 1-3 (auth, registry-resolve, ledger-exists), reachable with
//   an EMPTY batch, plus the empty-batch no-op (loop runs zero times → steps 5-6 with sumAq == 0).
//   The zero-AQ guard (4a) and the entire ingestion path (4a-6) require a non-empty batch and are
//   therefore skipped below. Their AUTHORITATIVE coverage is the end-to-end spec
//   fracDelegationInstance.algoquarters.e2e.spec.ts (localnet), which drives the real registry.
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
const seedLedger = (contract: FracDelegationInstanceContract, totalAq = 1000): void => {
  contract.committeeAq(NUM).value = { totalAq: u32(totalAq), ingestedAq: u32(0), numAccounts: u32(0) }
}

describe('FracDelegationInstance.ingestAq', () => {
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
      seedLedger(contract, 1000)

      contract.ingestAq(NUM, [])

      const ledger = contract.committeeAq(NUM).value
      expect(ledger.totalAq.asUint64()).toEqual(u32(1000).asUint64())
      expect(ledger.ingestedAq.asUint64()).toEqual(u32(0).asUint64())
      expect(ledger.numAccounts.asUint64()).toEqual(u32(0).asUint64())
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Ingestion path — everything that needs a NON-EMPTY batch (steps 4a-6). BLOCKED on the pinned
  // toolchain: `clone(accountAqs)` fails on the Account reference field, and step 4b additionally
  // clone()s FracInstance { appId: Application } inside the registry inner call. Enable once the
  // testing lib clones reference-type fields (>= 1.2.0) AND the cross-contract call can be wired to a
  // seeded FracDelegationRegistryContract. Until then these are covered end-to-end in
  // fracDelegationInstance.algoquarters.e2e.spec.ts. Kept as executable documentation of intent.
  // ───────────────────────────────────────────────────────────────────────────
  describe.skip('ingestion path (needs testing lib >= 1.2.0 + live registry inner call)', () => {
    // Scenario: a zero-AQ row is rejected (step 4a) before its registry inner call — the pipeline
    //   floors sub-1-AQ accounts out, so a zero here is bad input and must not cost a box or a call.
    //   Unreachable on 1.1.0 only because the enclosing clone(accountAqs) throws first.
    it('rejects a zero-AQ row before making any registry call, with errZeroAq', () => {
      void errZeroAq
    })

    // Scenario: a batch writes one accountAq box per row and rolls the sums into the ledger —
    //   ingestedAq += Σ aq, numAccounts += rows. Each address is resolved to a fresh account ID by
    //   the registry, so afterward tryGetAccountAq(id, NUM) == the row's aq.
    it('writes one box per account and accumulates ingestedAq / numAccounts', () => {})

    // Scenario: the registry side-effect — every ingested address is minted an account ID and linked
    //   to this instance (getOrCreateAccountWithInstance). An address never seen before gets a new
    //   id; the instance's numAccounts on the registry bumps once per genuinely-new link.
    it('mints a registry account ID and links each account to the instance', () => {})

    // Scenario: an address the registry already knows keeps its existing id and is not re-linked —
    //   getOrCreateAccountWithInstance is idempotent in both dimensions.
    it('reuses the account ID of an already-registered account', () => {})

    // Scenario: write-once per [account, committee] (step 4c). A repeat within a batch, or a replay
    //   across batches, hits an existing accountAq box and is rejected — ingestedAq can never
    //   double-count. Expected error: errAccountAqExists.
    it('rejects a duplicate account with errAccountAqExists', () => {
      void errAccountAqExists
    })

    // Scenario: the overflow guard (step 5). A batch whose Σ aq would push ingestedAq past totalAq is
    //   rejected whole, leaving the ledger untouched. Expected error: errTotalAqExceeded.
    it('rejects a batch that would exceed totalAq with errTotalAqExceeded', () => {
      void errTotalAqExceeded
    })

    // Scenario: successive batches accumulate — ingestedAq/numAccounts sum across calls, and the
    //   committee is complete exactly when ingestedAq == totalAq.
    it('accumulates across multiple batches', () => {})
  })
})
