# Rewrite `increaseBudget` into a shared `sdk-shared` package (AVM13)

## Context

Every write in the frac SDK goes through `executeTxns` → `getIncreaseBudgetBuilder`: one exploratory simulate sizes a prepended `increaseBudget(itxns)` opup call. The mechanism predates AVM13 and has four problems:

1. Reference-slot padding is a separate, static mechanism (`padForRefSlots`, hand-measured counts at 5 maker sites in `instance/sdk.ts`) instead of being derived from the same simulate.
2. The probe requires the sender to carry a 256k µAlgo fee (`atc.transactions[0].txn.fee = 256_000n`), so low-balance senders fail the probe with an overspend error before anything is measured.
3. Fees are hardcoded 1000 µAlgo arithmetic — wrong for AVM13 usage-based group fees and for PQ senders (3000 µAlgo base on outer txns). The repo rule (see `src/util/groupUsageFee.ts`) is: read the fee off simulate, never compute it.
4. Opcode accounting is wrong for inner-heavy groups: budget added by the target app's _own_ inner calls materializes only when those inners execute, i.e. possibly after the point of need, so it cannot be blindly counted as available — but never counting it (the current heuristic) over-provisions opups and fees. Fix (per user feedback): bracket the true requirement between an optimistic bound (all inner budget counts) and a guaranteed-safe pessimistic bound (none does), then binary-search to the correct opup count with 2–3 budget-probe simulates. (The opup's own inners run in txn 0, so their budget is always available to everything after.)

Scope: **both SDKs, via a new `projects/sdk-shared` workspace package.** The duplication was always a placeholder (`base.e2e.spec.ts` pinned the two copies' constants together "until the shared SDK package lands"), so the rewrite lands there once and `ggov-sdk` and `frac-delegation-sdk` both consume it — `padForRefSlots` is deleted from both, including ggov's one call site in `importFracDelegations`. Public API preserved by re-export: `SIMULATE_PARAMS` (byte-identical — ~30 reader sites + a contracts spec import it), `getIncreaseBudgetBuilder`, `executeTxns` / `createTxnExecutor`, and the three constants. Two deliberate exceptions, both from finding 5: `UPLOAD_APPROVAL_MAX_FEE_MICROALGOS` is gone from both packages' `constants.ts`, and `uploadPeriodApproval` / `uploadInstanceApproval` no longer take a `staticFee` — the executor prices those groups now, so neither had a meaning left to preserve.

## Verified API facts (don't re-derive)

- `composer.buildTransactions(): Promise<BuiltTransactions>` is public in algokit-utils 9.2.0 (`types/composer.d.ts:1237`) and returns fresh, **ungrouped**, mutable `Transaction[]` — no `@ts-expect-error` / `atc.clone()` needed. `Transaction.fee` is writable in algosdk 3.7.0.
- `Config.populateAppCallResources` defaults to `true` → every `builder.send()` already runs an internal populate simulate (no `extraOpcodeBudget`, real fees) that throws loudly on failure — it is a free final verification pass. Do NOT reimplement resource distribution.
- algosdk 3.7.0 simulate exposes `SimulateTransactionGroupResult.{groupUsage, groupFeesPaid, appBudgetConsumed, unnamedResourcesAccessed, failureMessage}` and per-txn `unnamedResourcesAccessed` / `feesPaid`. `groupUsage` is in millionths of a min-fee unit, inners included.
- `src/util/groupUsageFee.ts` already has `feeFromGroupUsage(simResponse, minFee)` and `minFeeMicroAlgos(algod)`; `uploadInstanceApprovalProgram` (registry/sdk.ts:381-387) already uses the probe → staticFee pattern. Reuse both.
- Usage-shortfall rejections read: `txgroup with 1mA fees is less than 1.203mA (usage=1.202600 * base=1mA)`.
- Cost constants stay: `increaseBudgetBaseCost = 23`, `increaseBudgetIncrementCost = 21` (pinned by `base.e2e.spec.ts`). Each opup itxn = one inner app-create+delete = +700 budget, one min fee; the opup outer itself adds 700 budget + 8 ref slots.

## Empirical findings (probed on testnet + localnet throwaway deploy, 2026-08-24)

1. **PQ premium is invisible to empty-signature simulates.** A funded testnet PQ account (`QQGN…`) simulates a payment at `groupUsage = 1_000_000` — algod does NOT infer PQ-ness from the sender; the surcharge is tied to the signature envelope (ledger spec: "each transaction authorized with a post-quantum signature raises the minimum fee requirement of its group"). → PQ support = probe with the writer's own **`emptyTxnSigner`** (algosdk 3.7.0 `AddressWithEmptyTransactionSigner`, produced by `addressWithSignersFromRawPQSigner`), which placeholder-signs so simulate prices the PQ scheme. Thread an optional `emptyTxnSigner?: TransactionSigner` through `SenderWithSigner` (non-breaking); probes use `writerAccount.emptyTxnSigner ?? makeEmptyTransactionSigner()`. Measured on localnet (go-algorand 5.0.0, 2026-08-26): the premium is a flat **3x per PQ-authorized transaction** — 1 txn 1_000_000 -> 3_000_000, 2 txns -> 6_000_000, 3 txns -> 9_000_000, and a mixed PQ+classic pair -> 4_000_000. The envelope must belong to the sender: binding a placeholder envelope to an ed25519 account prices correctly only while the group still fails the usage-fee check, because that check aborts before signature validation; give it enough fee to pass and algod rejects it with `pq signature authorizer mismatch` (`fixSigners` does not paper over a PQ authorizer). A genuine PQ sender probes clean at the 256k headroom.
2. **The fee sink cannot spend, even in simulate**, on networks where it is the sink ("cannot spend from fee sink address" on localnet AND testnet, at fee 0). The sink-payer idea is dead outside mainnet/fnet → dropped entirely (user-confirmed replacement below).
3. **Fee headroom on the probe remains mandatory.** Fee-0 inners still fail eagerly at `itxn_submit` ("group fee 0.0A too small (needs 1mA more)") — evaluation aborts mid-app (partial `appBudgetConsumed`, 0 inners executed). The AVM13 usage check is a separate, end-of-group check that does NOT abort evaluation (an under-fee'd group with no inners reports full `appBudgetConsumed` + `groupUsage` + the required fee in `failureMessage`).
4. **`groupUsage` = 1_000_000 per txn including inners** for classic txns (outer + 2 inners = 3_000_000) — validates the fee-shortfall heuristic `adjUsage > countInclInners × 1_000_000`.
5. **The approval upload needs no hand-declared box references, and the ones it declared were twice too many** (localnet, 2026-08-26). Box I/O budget is **2048 bytes per reference, not 1024** — the AVM names the figure when given one ref too few (`write budget exceeded (4066 > 2048) while creating box 0x506170`), and a min-refs sweep under a strict simulate (`allowUnnamedResources: false`) lands on `ceil(b/2048)` at every boundary: 2048→1, 2049→2, 4096→2, 4097→3, 6144→3, 6145→4, 8188→4. More importantly, resource population **does** add more than one ref per distinct box: simulate reports the shortfall as `extraBoxRefs` (1 for a 4066-byte write with one ref declared, 3 for 8188) and `populateAppCallResources` materialises them as empty refs on the same txn. `planGroupExtras` already costs those reported refs as slots, so `planGroupExtras` on the bare upload returns `{padsForRefs: 0, prepends: 0, itxnsHi: 0, feeCheckNeeded: true}` and `executeTxns` sends `increaseBudget` (staticFee 1203 µAlgo, the v13 usage fee) + `uploadPeriodApproval`, box byte-identical to the bytecode on the create and the delete+recreate paths alike. → `BOX_IO_BYTES_PER_REF` / `boxIoRefsFor`, the `boxReferences` arrays, the `staticFee` option and its `UPLOAD_APPROVAL_MAX_FEE_MICROALGOS` ceiling are all deleted from both SDKs; the uploads run through the executor like every other write.

## Files

1. **New package `projects/sdk-shared`** (dual ESM/CJS build copied from `ggov-sdk`), holding the
   rewritten `increaseBudget.ts` + `txnExecutor.ts`, plus what they need: `groupUsageFee.ts`,
   `noteNonce.ts`, `spendable.ts`, the three cost/group-size constants, and
   `SenderWithSigner` / `SendResult`. `SenderWithSigner` gains an optional `emptyTxnSigner` so PQ
   writers can pass the placeholder-signer from `addressWithSignersFromRawPQSigner` and have probes
   price the surcharge.
2. Both SDKs depend on it (`workspace:*`) and re-export from `constants.ts`, `types.ts` and
   `registry/index.ts`, so no public API and no existing import site changes.
3. `padForRefSlots.ts` deleted from both SDKs. Call sites: frac's 5 in `instance/sdk.ts`, ggov's 1
   in `registry/sdk.ts` (`importFracDelegations`) — each replaced by a comment naming the slots the
   executor now measures.
4. `readCache?: Map<string, unknown>` added to the four `*MethodBuilderArgs` interfaces; the
   executor owns one per run and `escrowCountUpperBound` memoises `getEscrows` in it.
5. New spec: `projects/contracts/smart_contracts/frac-delegation/fracDelegation.executor.e2e.spec.ts`
6. `base.e2e.spec.ts`'s cross-SDK constant sync test deleted — one constant, one pin.
7. Build orchestration: `sdk-shared` registered in the workspace `.algokit.toml` build list
   between `contracts` and the two SDKs that consume it, with its own `.algokit.toml` so the
   unordered commands (`lint`, `typecheck`, `format-check`) pick it up. CI's explicit
   `--project-name` build lists and change-path filters updated to match, and the three
   frontend/storybook CD workflows switched to `pnpm --filter 'ggov-sdk...' build` so the
   dependency is pulled in topologically rather than named again.

## Algorithm (`projects/sdk-shared/src/increaseBudget.ts`)

Keep `SIMULATE_PARAMS` export unchanged. `FEE_SIMULATE_PARAMS = { ...SIMULATE_PARAMS, extraOpcodeBudget: 0 }` (module-local).

### `probeSimulate(composer, algod, emptySigner, { extraOpcodeBudget })` → `{ response, headroomFee }`

1. `txns = (await composer.buildTransactions()).transactions`; wrap each in a fresh `AtomicTransactionComposer` with `emptySigner` (= `writerAccount.emptyTxnSigner ?? makeEmptyTransactionSigner()` — the PQ path, finding 1).
2. **Attempt 1 (as today):** `txns[0].fee = 256_000n`, simulate with `new modelsv2.SimulateRequest({ txnGroups: [], ...params })`.
3. **Detect balance failure:** `failureMessage` matches `/overspend|tried to spend|below min/`. If matched → **retry with a balance-derived headroom** (user-confirmed; no third-party payer): one `getSpendableBalance(algod, sender)` call (`src/util/spendable.ts`, exists), then
   `headroom = clamp(spendable − Σ(other debits by txn[0].sender in the group: fees + payment amounts), realFee(txns[0]), 256_000)` — "a safe value accounting for fees paid later in the group". Rebuild fresh txns, set `txns[0].fee = headroom`, re-simulate once.
4. If the retry still fails on balance, let the plan proceed with whatever was measured (matching the "don't mask real failures" rule) — the send will surface the genuine insufficient-balance error.

### `planGroupExtras(builder, algod)` → `Plan | undefined` (Sim #1)

From `txnGroups[0]` of the probe (run with `extraOpcodeBudget: 179200`):

**Pads for refs** (replaces `padForRefSlots`):

- `appls` = built txns with type `appl` (sink payment excluded); `declared_i` = lengths of each appl txn's `accounts + foreignApps + foreignAssets + boxes` (static worst-case declarations, e.g. vote's, keep counting).
- Slot costing over unnamed resources (deliberately conservative vs algokit's `populateGroupResource`): `accounts` 1, `apps` 1, `assets` 1, `boxes` 2 (ref + possible owning-app ref), `extraBoxRefs` 1, `appLocals` 2, `assetHoldings` 2.
- Per-txn guard: `declared_i + txnLevelCost_i > 8` → throw (the 8-slot per-txn cap can't be padded around). Group guard: total > 128 → throw (simulate's unnamed-ref cap).
- `padsForRefs = max(0, ceil(totalSlots / 8) − appls.length)`.

**Opup itxns — optimistic-first, then bounded binary search (user feedback):**

The true requirement sits between two closed-form bounds, because budget added by the target app's _own_ inner app calls materializes only as those inners execute — it may or may not arrive before the point of need:

- `innerAppls` = recursive count of inner `appl` txns in sim #1's `txnResults[..].txnResult.innerTxns`.
- With `prepends` = number of prepended opup/pad calls (each an outer app call: +700 budget, −23 base cost), and candidate `itxns` costing 21 each while adding 700 each (the opup runs in txn 0, so its budget always arrives in time):
  - **`itxnsHi` (pessimistic, guaranteed-safe — no target-inner budget counts):** smallest itxns with `appBudgetConsumed + prepends × 23 + 21 × itxns ≤ 700 × (appls.length + prepends + itxns)` → `itxnsHi = max(0, ceil((appBudgetConsumed + prepends × 23 − 700 × (appls.length + prepends)) / 679))`.
  - **`itxnsLo` (optimistic — ALL inner-added budget counts):** same formula with `available += 700 × innerAppls`.
- Solve with `prepends = padsForRefs`; if `itxnsHi > 0 && padsForRefs == 0`, re-solve with `prepends = 1`.
- If `itxnsLo == itxnsHi` → done, zero extra simulates (covers the common cases: groups with no inner app calls, and groups comfortably inside budget).
- Else **probe simulates** (each: real group shape with prepends, NO `extraOpcodeBudget`, fee headroom via the probe mechanism, `allowUnnamedResources`, empty signers):
  1. Test `itxns = itxnsLo`. Pass → use it. Fail on a budget error (`failureMessage` matches `/budget/`) → binary search.
  2. Binary search in `(lo, hi]` with up to 2 more probes (`mid = floor((lo + hi) / 2)`), maintaining the invariant that `hi` passes (it is safe by construction and never needs testing). After ≤2 probes, use the smallest verified-passing value, else `itxnsHi`.
  - A probe failing with a NON-budget error aborts the search → use `itxnsHi` and let send surface the real error (matches the "don't mask real failures" rule).
  - So the opup sizing costs 0–3 budget probes on top of sim #1 (the user's "simulate 2/3 times"), and only for inner-heavy groups that are actually over budget — exactly where the pessimistic bound overpays (~1 min fee per avoided itxn, e.g. up to ~34 itxns ≈ 0.034 ALGO on an 11-escrow vote).
- Probe cheaply: build the final group ONCE (maker rerun with prepends, `itxns = itxnsHi`), then for each probe take fresh `buildTransactions()` output and overwrite the first prepend's itxns app-arg (`appArgs[1] = encodeUint64(candidate)`) in the simulate-only copy — no maker rerun per probe. If the built `Transaction`'s appArgs prove immutable in practice, fall back to one maker rerun per probe.
- After the search picks `itxns < itxnsHi`, rebuild via maker rerun with the final value (the probe copies never leave the SDK).
- Guard: `itxnsHi > 16 × finalGroupSize` → throw (pooled inner-txn allowance).

**Fee-shortfall detection** (no extra round trip): count txns incl. inners recursively from `txnResults[..].txnResult.innerTxns`; `feeCheckNeeded = groupUsage > countInclInners × 1_000_000`. No adjustment term: the headroom inflates only txn[0]'s fee field, and usage does not depend on fees (finding 4 validates 1e6 per classic txn incl. inners). Classic groups sit inside the free allowance → false → no `minFee` fetch on the common path. Big-args premium → true; PQ premium → true only when the probe carried the PQ placeholder envelope via `emptyTxnSigner` (finding 1).

**Non-budget `failureMessage`:** keep today's deliberate behavior — still return the plan and let send surface the true error (early-returning used to mask real failures behind budget errors); skip fee logic (usage may be partial).

Return `undefined` iff `padsForRefs == 0 && itxns == 0 && !feeCheckNeeded`.

### `applyPrepends(factory, plan, sender, signer, staticFeeOnFirst?)`

- First prepend carries the itxns: `increaseBudget({ args: { itxns }, sender, signer, note: `opup-${noteNonce()}`, ... })` with `staticFee` when a fee delta is known, else today's `extraFee: (itxns × 1000).microAlgo()` / `maxFee: ((itxns+1) × 1000).microAlgo()` (any deviation flips `feeCheckNeeded` anyway). Prepending keeps its inners executing before the heavy calls and keeps donating the 8 ref slots documented as load-bearing (`fracDelegationInstance.periods.e2e.spec.ts:191-197`).
- Remaining `padsForRefs − 1` prepends: `{ args: { itxns: 0 }, note: `refs-${i}-${noteNonce()}` }`.
- Group-size guard: `plan.txnCount + prepends > MAX_GROUP_SIZE` → throw naming the method.
- When `feeCheckNeeded` alone (pads = itxns = 0), still prepend one `increaseBudget(0)` as the fee carrier.

### `getIncreaseBudgetBuilder` (exported compat wrapper, same signature)

`const plan = await planGroupExtras(builder, algod); return plan && applyPrepends(newBuilderFactory, plan, sender, signer)` — behavior superset of today (also pads for refs). The wrapper cannot rerun the caller's maker, so it sizes with `itxnsHi` (pessimistic) only — safe, and no worse than today; the optimistic search lives in `executeTxns`.

## `executeTxns` flow (`projects/sdk-shared/src/txnExecutor.ts`)

```
builder = await txnBuilder(args)                                   // maker run 1
plan = await planGroupExtras(builder, algod)                       // Sim #1; yields pads, itxnsLo/itxnsHi, feeCheckNeeded
if (!plan) return builder.send(sendParams)                         // common path: 2 simulates total (Sim #1 + populate's)

builder = await txnBuilder({ ...args, builder: applyPrepends(…, itxnsHi) })  // maker run 2, built once at the safe bound
if (plan.itxnsLo < plan.itxnsHi) {
  itxns = binary-search per §"Opup itxns": probe simulates on mutated copies (appArgs[1] swap), 1–3 probes
  if (itxns < plan.itxnsHi) builder = maker rerun with applyPrepends(…, itxns)
  lastPassingProbe = the probe response for the chosen itxns, if one was taken
}
if (plan.feeCheckNeeded) {
  r2 = lastPassingProbe ?? probeSimulate(await builder.composer(), algod, FEE_SIMULATE_PARAMS)  // reuse: probes already run
                                                                    // without extraOpcodeBudget, so their groupUsage is real
  minFee = await minFeeMicroAlgos(algod)
  required = feeFromGroupUsage(r2.response, minFee)                 // ceil(minFee × groupUsage / 1e6)
  delta = required − (groupFeesPaid − (headroomFee − realFee(txn0)))  // strip only the probe's fee inflation;
                                                                    // groupFeesPaid includes self-paying inners (MBR top-ups)
  if (delta > 0) builder = maker rerun with staticFee on first prepend = (1 + itxns) × minFee + delta
}
try { return await builder.send(sendParams) }
catch (e) {
  if (/budget/ matched && retries < 2)  { itxns = min(itxns + 2, itxnsHi followed by itxnsHi + 2); rebuild; retry }  // backstop only
  if (/fees is less than/ matched && !feeRetried) { run the feeCheckNeeded branch once; retry }
}
```

- The fee delta lands only on the prepended opup, never the real calls — preserves `fracDelegationInstance.vote.e2e.spec.ts:1005-1037` (vote txn fee identical with/without MBR top-up; top-up inners pay their own fees and are usage-neutral against `groupFeesPaid`).
- Simulate counts, **measured on localnet** (`fracDelegation.executor.e2e.spec.ts` pins them):
  a write needing nothing 2; an inner-heavy 3-escrow vote 4 (the maker's own escrow read, Sim #1,
  one opup probe, the send's population pass); the same vote from a writer under the probe headroom 5. Worst case is 9. Three things hold it there, and each was worth measuring:
  - the probe headroom is resolved **once per run** and cached on the `ProbeContext`, not
    rediscovered per probe (a low-balance writer costs +1 total, not +1 per probe);
  - the maker's own reads are cached for the run — measured at −2 on the 3-escrow vote, and it is
    what lets the opup count and the fee share a single maker rerun;
  - when the usage fee is owed and no probe has passed, the search's last slot is spent on
    `itxnsHi` (guaranteed to pass), so the fee read costs no simulate of its own.
- `createTxnExecutor` unchanged; `uploadInstanceApprovalProgram` keeps its own probe.

## Edge cases / notes

- `registerEscrows` at 15 escrows + 1 opup = exactly 16 txns: auto-pad cannot fire there — note it in `MAX_ESCROWS_PER_REGISTER_GROUP`'s docblock. Capacity re-check under auto-pad: ingestAq@40 → ~83 slots → 11 app calls ✓; vote@11 escrows → ~79 slots → 10 txns ✓. No constant changes needed.
- Slot-costing overcount → at most one extra pad (one min fee). Undercount → populate's simulate fails loudly; fix the costing, not the algorithm.
- State-dependent resources (vote's static `appReferences`/`boxReferences`, instance/sdk.ts:756-763) MUST stay declared — simulate sees only the taken branch, and box refs encode against the txn's own foreign-apps at build time.
- PQ (probed, finding 1): the premium is priced only when the probe txns carry a PQ placeholder envelope — a plain empty signer measures non-PQ usage. The SDK honors `writerAccount.emptyTxnSigner` everywhere it probes: `executeTxns`, the `getIncreaseBudgetBuilder` compat wrapper (optional trailing param), and the approval uploads, which no longer hand-roll a `skipSignatures` probe of their own. `writerFromAddressWithSigners` adapts algosdk's `addressWithSignersFromRawPQSigner` output to `SenderWithSigner` in one call. Degrades safely: without `emptyTxnSigner`, the premium goes undetected at probe time and the send-catch `/fees is less than/` retry picks it up (one extra round trip).
- PQ coverage stops at the sizing path, and cannot go further without a real Falcon key. The executor spec drives a genuine PQ address (derived from a placeholder Falcon public key via `addressFromPQKey`, funded, made registry admin) and asserts the plan flips to `feeCheckNeeded` only when the writer's own signer is used — but that account cannot sign, so a genuinely PQ-signed **send**, and the `/fees is less than/` retry that backs up a PQ writer with no `emptyTxnSigner`, stay untested. Binding the envelope to a signable ed25519 account is not a way around it (finding 1: authorizer mismatch).
- The frontend passes no `emptyTxnSigner`: @txnlab/use-wallet exposes nothing to build one from, in the installed 4.4.0 or in 5.0.0 (`WalletAccount` is `{ name, address, metadata? }`; `BaseWallet` has only `transactionSigner`; no `pqsig`/`falcon` anywhere in its declarations, and the v5 release notes do not mention PQ). PQ users there fall back on the send-time retry. Noted at both `writerAccount` literals in `useGGovSDK.ts`, along with the trap that the empty signer must not go through `wrapSignerWithPhase`.

## Bugs this surfaced

Both were live in the rewrite before it was shared, and both were found by running ggov-sdk's suite
against it — frac's own methods happened to mask them.

1. **A dropped prepend.** `planGroupExtras` re-solves with one prepend when the bare group is over
   budget, and that prepend's +700 drives `itxnsHi` back to 0 — but the bail-out guard only checked
   `itxnsHi === 0`, so it returned `undefined` and discarded the very prepend that made it zero.
   Every frac method that needs an opup also needs reference pads, so `padsForRefs > 0` kept the
   guard from firing there; ggov's `addTopic` and `ingestGovs` (over budget by less than one app
   call's worth, no pads) hit it immediately. Guard now tests `prepends === 0`.
2. **An inner-txn ceiling that rejected working groups.** The guard sized the opup's inners at 16
   per transaction in the group, so a ggov `vote` across 78 topics — 135 itxns, which the old
   sizing produced and the network accepted — was refused client-side. Opup inners are app calls
   sharing the group's 256-app-call allowance, not a per-transaction quota; sized against the group
   total now, consistent with `MAX_GROUP_BUDGET = 700 * 256`.

Two more, found by review before implementation: a missing `await` on `composer.count()` that left
`txnCount` holding a Promise (so the `MAX_GROUP_SIZE` guard compared `NaN` and never fired), and a
`staticFee` that undershot by `(itxnsHi − itxns) × 1000` whenever the search narrowed, because it
was read off a group _built_ at `itxnsHi`. The fee is now the exact identity
`required − (groupFeesPaid − headroomFee)` — everything the group pays apart from txn 0 — which
holds whatever txn 0 was built with.

## Verification

Prereqs: `pnpm install`, then `algokit project run build` from the repo root — the workspace's
`.algokit.toml` orders the projects, and `sdk-shared` is registered between `contracts` and the two
SDKs that consume it. Localnet running/reset. Then from `projects/contracts`:

1. `pnpm vitest run smart_contracts/base/base.e2e.spec.ts` — on-chain cost-constant pins.
2. `pnpm vitest run smart_contracts/frac-delegation/fracDelegation.executor.e2e.spec.ts` — the
   simulate-count pins.
3. `pnpm vitest run smart_contracts/frac-delegation/fracDelegationInstance.vote.e2e.spec.ts` —
   fee-equality + static-ref regressions.
4. `pnpm vitest run smart_contracts/ggov-period smart_contracts/ggov-registry` — ggov-sdk's own
   coverage, now that it runs on this executor. Required: it is the only coverage of
   `importFracDelegations` without its static pad, and of the two bugs above.
5. The full suite: `pnpm vitest run` — 532 passed / 0 failed / 5 skipped / 12 todo across 29 spec files as of this change. It takes ~18 minutes; running it per directory (`base ggov-period ggov-registry`, then `frac-delegation` in two halves) keeps each invocation short.

New spec `fracDelegation.executor.e2e.spec.ts`:

- **Simulate budget:** hook `algod.simulateTransactions` and pin the counts — a write needing
  nothing is 2, an inner-heavy vote is 4, and the same vote from a low-balance writer is exactly
  one more. The last is what proves the headroom is cached per run rather than per probe.
- **Low-balance writer:** fund a writer with less than 0.256 spendable but enough for the real fees; heavy write succeeds (probe attempt 1 overspends at 256k → balance-derived headroom retry); assert the sent group's fees are the normal ones.
- **Auto-pad shape:** ingestAq@40 accounts and vote@11 escrows; assert prepends come first and the first txn carries the itxns.
- **Opup search:** for an inner-heavy over-budget group (e.g. large vote), decode the sent opup's itxns arg and assert it is below the pessimistic bound (`ceil((consumed − 700 × outers) / 679)`-ish) — proving the binary search engaged — while the group still succeeds on-chain.
- **Fee neutrality:** classic (non-PQ) groups pay the same fees as before the rewrite (vote txn fee = minFee + innerCalls × 1000).
- **Post-quantum pricing:** a genuine PQ sender's group plans as `feeCheckNeeded` with the writer's `emptyTxnSigner` and as "needs nothing" without it. Probe-only, per the edge-case note above.
- **Usage fee:** a ~5KB `uploadInstanceApproval` — the one write that trips the v13 usage fee without a PQ signer — pays the whole premium on the prepended opup, keeps the min fee on the call itself, costs three simulates, declares no box references, and lands a byte-identical box. This is the regression pin for finding 5.
