# `uningestAq` — AlgoQuarters un-ingestion

Reverses AQ ingestion on a `FracDelegationInstance`: removes per-account AlgoQuarters from a
committee's ledger, reclaims the box MBR, and re-opens the committee for a corrected total.

## Why it exists

AQ ingestion (`startAqIngest` / `ingestAq`) is append-only with two one-way doors that `uningestAq`
is the sole way to re-open:

1. **A frozen total.** `startAqIngest` refuses to re-set `totalAq` once `ingestedAq > 0`
   (`errIngestedAqNotZero`). A committee ingested against a bad pipeline total is otherwise stuck.
2. **Locked MBR that only grows.** Committees are *per-period* (`CommitteeMetadata.periodStart/End`),
   so every period opens a fresh `committeeAq` ledger and one `accountAq` box per account — each
   locking 6,900 µALGO of the instance app account's balance. For a 10k-account instance that is
   ~69 ALGO per committee, accreting every period, with nothing that ever returns it.

`uningestAq` is both the **correction path** (walk back a bad batch) and the **MBR lifecycle** (drain
a settled committee to reclaim its box MBR). It mirrors the gGov registry's `uningestGovs`
(`ggovRegistry.algo.ts`), minus that method's superbox bookkeeping: `accountAq` is a `BoxMap`, so
deletion is by key with no offset to maintain and no ordering rule.

## Signature

```
uningestAq(committeeNumId: Uint16, accounts: Account[]): void   // operator-gated
```

Takes **addresses** (like `ingestAq`), so operators keep using the same account lists they ingested
with. The contract resolves each address to its frac-registry account ID on-chain via the registry's
readonly **`getAccount`** — a read, *not* get-or-create: an unregistered address resolves to account
ID 0, whose box never exists, so it is rejected as "not ingested" rather than minting anything.

## Behaviour

- **Order-independent, no duplicates.** A `BoxMap` deletes by key. A duplicate within a batch fails
  on its second pass (the box is already gone); a replayed batch fails whole. The group is atomic, so
  a rejection removes nothing.
- **Counters roll back.** `ingestedAq -= Σ removed`, `numAccounts -= accounts.length` — both
  underflow-safe by construction (every removed box's AQ and count were added by the `ingestAq` that
  wrote it; the AVM rejects any underflow regardless).
- **Re-opens the ledger.** Draining to `ingestedAq === 0` lets `startAqIngest` commit a fresh total.
- **Reclaims MBR.** `box.delete()` lowers the instance app account's minimum balance by 6,900 µALGO
  per account; the freed ALGO becomes spendable and is swept with the existing `withdrawALGO`.
- **Does NOT touch the registry.** Account IDs are permanent and the account→instance association
  `ingestAq` created stays true (the account may hold AQ in this instance's other committees). The
  registry's per-instance `numAccounts` therefore counts accounts *ever associated*, not accounts
  currently ingested — do not read it as a live count.

## Errors

| Code | Meaning |
|---|---|
| `ERR:AUTH` | caller is not the operator |
| `ERR:FA_NS` (`errAqNotStarted`) | no ledger for this committee |
| `ERR:FA_AC` (`errNumAccountsExceeded`) | batch larger than the ingested account count |
| `ERR:FA_NX` (`errAccountAqNotExists`) | account has no AQ box in this committee (never ingested, or wrong committee) |

Validation ordering mirrors `ingestAq`: operator check → ledger-exists → `accounts.length <=
numAccounts` (cheap, before any box or inner call) → per-account `getAccount` then box-exists.

## Batch sizing & cost

Same profile as `ingestAq` — addresses in, one `getAccount` inner call per account:

- **References:** 2 per account (registry `accounts` box + instance `accountAq` box) + registry app
  ref + `committeeAq` box = `2N + 2`. (One lighter than ingest's `2N + 3`: `getAccount` doesn't touch
  the registry `instances` box.)
- **App args:** `8 + 32N ≤ 2048` → N ≤ 63.
- SDK cap **`MAX_ACCOUNTS_PER_UNINGEST_AQ = 40`**, parity with ingest and header room under the 16-txn
  group limit; tunable toward ~63 once confirmed by a localnet simulate.
- **Fee:** `extraFee = N × 1000` µALGO (one `getAccount` inner call per account); each inner call also
  adds 700 to the opcode pool.
- Draining 10k accounts ≈ 250 groups, ≈ 12–13 ALGO in fees; **~69 ALGO of box MBR returned** to the
  instance app account's spendable balance. The registry's `accounts` boxes are *not* reclaimed — IDs
  are permanent.

## The cyclical-import trap

The frac registry `compile()`s the instance in `createInstance`, so `compileArc4(...)` for the
`getAccount` call **must be inlined at the call site**, never hoisted to a `const` — hoisting
materialises the registry's whole program and puya rejects the cycle. Same fix `ingestAq` uses.

## Future: internal-voting guard

`voteInternal` does not exist yet, so nothing reads per-account AQ during voting. When it lands,
`uningestAq` will need a guard refusing to drain a committee any period has live votes against
(mirroring `syncPeriod`'s `cacheHasVotes` / `errGGovHasVotes`) — removing an account's weight after it
voted would corrupt the tally denominator. The method's doc-comment flags this.

## SDK

`FracDelegationSDK` (`frac-delegation-sdk/src/instance/sdk.ts`):

- `uningestAq({ committeeNumId, accounts })` — one group; pads references and sets `extraFee`.
- `uningestAqAll({ committeeNumId, accounts })` — chunks a whole set at `MAX_ACCOUNTS_PER_UNINGEST_AQ`.

To recover the freed ALGO afterward, call `withdrawALGO({ receiver, amount })`. Address→ID resolution
is on-chain, so callers pass addresses directly (no pre-resolution needed).

## Files

| File | Change |
|---|---|
| `base/errors.algo.ts` | `errAccountAqNotExists` (`FA_NX`), `errNumAccountsExceeded` (`FA_AC`) |
| `frac-delegation/fracDelegationInstance.algo.ts` | `uningestAq` method |
| `frac-delegation-sdk/src/constants.ts` | `MAX_ACCOUNTS_PER_UNINGEST_AQ` |
| `frac-delegation-sdk/src/instance/sdk.ts` | `makeUningestAqTxns` / `uningestAq` / `uningestAqAll` |
| `frac-delegation/fracDelegationInstance.algoquarters.e2e.spec.ts` | `uningestAq` describe blocks |

No `fracDelegationRegistry.algo.ts` change — `getAccount` already exists and is readonly.
