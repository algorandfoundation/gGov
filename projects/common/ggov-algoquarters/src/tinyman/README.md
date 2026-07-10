# Tinyman pipeline

AlgoQuarters for **tALGO** and **stALGO** holders — [Tinyman's consensus staking tokens](https://github.com/tinymanorg/tinyman-consensus-staking). Balances are rebuilt by replaying every ASA transfer of the two assets (inner transactions included).

## Files

Snapshot `snapshots/tinyman/<round>.json`:

```json
{
  "round": 60000000,
  "balances": { "AAAA…": { "talgo": "1000000", "stalgo": "0" } },
  "excluded": { "BBBB…": { "talgo": "500000", "stalgo": "0" } }
}
```

Algoquarters files follow the shared schema plus `rate`, the fixed tALGO/ALGO rate for the window (12-decimal fixed-point string).

## Code structure

```text
snapshot.ts            Snapshot CLI — full transfer scan from asset creation to a target round
algoquarters.ts        Algoquarters CLI — window scan, rate fetch, algoquarter computation, next snapshots
verify.ts              Live check — replay vs current asset holder balances
compute.ts             Time-weighted balance accrual
ledger.ts              Applies transfers, opt-ins, close-outs to the balance map
indexer.ts             Transfer scan and rate-event queries
exclusions.ts          Addresses filtered from algoquarter accrual
constants.ts           Mainnet constants
types.ts               Pipeline types
snapshot/
├── operations.ts      Snapshot creation, (de)serialization, persistence, comparison
└── stats.ts           Snapshot supply and holder analysis
```

## Design notes

- **Fixed rate: one per committee window.** `effectiveMicroAlgo = (talgo + stalgo) × tAlgoRate / RATE_SCALER`, where `tAlgoRate` is the first `rate_update(uint64)` ARC-28 event emitted by the tALGO app in `[periodStart, periodEnd)`. This is an approximation of reality — tALGO/ALGO drifts upward ~0.4%/month as staking rewards accrue, so the error is ~1.3% over a typical 3M-round window. Intentional: the rate is symmetrical across all holders and avoids continuous-rate complexity. The error does not compound (the rate is re-fetched each window). A two-rate interpolation could halve it if ever needed.
- **stALGO counts 1:1 with tALGO.** Correct by design: the staking contract mints and redeems at strict parity, and rewards are paid in TINY tokens, so the underlying tALGO position never changes size. Re-stakers lose no credit.
- **Exclusions at output time only.** Non-eligible addresses (e.g. app escrows) stay in the snapshot under `excluded` so total supply can always be verified against chain metadata; they are only omitted from algoquarter accrual. See [`exclusions.ts`](exclusions.ts).
