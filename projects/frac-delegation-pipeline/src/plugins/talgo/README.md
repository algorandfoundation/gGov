# tALGO plugin

AlgoQuarters for **tALGO** and **stALGO** holders — [Tinyman's consensus staking tokens](https://github.com/tinymanorg/tinyman-consensus-staking). Balances are rebuilt by replaying every ASA transfer of the two assets (inner transactions included).

The plugin covers both halves of the source: it recognizes tALGO's escrows (the `account_N` slots of the tALGO app's global state) for stage 1, and computes each holder's AlgoQuarters over a committee window for stage 3. It builds on the shared scan and snapshot primitives in [`src/aq`](../../aq/README.md).

This was a standalone CLI (`pnpm algoquarters:tinyman <start> <end>`) that wrote a manifest for someone to upload by hand. It now runs in-process: the pipeline calls `calculateCommitteeAQ`, gets the numbers in memory, and ingests them on chain in the same run. No manifest file is read or written.

## Snapshots

A snapshot at round `R` holds every address's tALGO/stALGO balance after all transactions in rounds `< R`. It is what a window starts from, so `[periodStart, periodEnd)` only scans its own rounds instead of all of history.

`snapshots/talgo/<round>.json`, at the package root:

```json
{
  "round": 60000000,
  "balances": { "AAAA…": { "talgo": "1000000", "stalgo": "0" } },
  "excluded": { "BBBB…": { "talgo": "500000", "stalgo": "0" } }
}
```

They are committed, and the only files this plugin writes. A run over `[periodStart, periodEnd)` verifies or creates one at every 1M-round boundary inside the window, so the next committee's start snapshot is normally one the previous run produced. Verification comes first: a stored snapshot that disagrees with a fresh replay throws before any AQ figure is returned.

When `periodStart` has no snapshot at all, `buildSnapshot` rebuilds it by scanning from asset creation. That is minutes of Indexer work, and the reason the files are committed.

## Overrides

Passed through the plugin's `overrides` argument:

| Override            | Default                     |                                                         |
| ------------------- | --------------------------- | ------------------------------------------------------- |
| `appId`             | mainnet tALGO app           | The app escrow recognition and the rate event read from |
| `snapshotsDir`      | `<package>/snapshots/talgo` | Where snapshots are read and written                    |
| `allowLargeHolders` | `false`                     | Downgrade the >40%-of-supply check to a warning         |

## Code structure

```text
index.ts               The plugin — escrow recognition, calculateCommitteeAQ, buildSnapshot, verifyAgainstChain
compute.ts             Time-weighted balance accrual
ledger.ts              Applies transfers, opt-ins, close-outs to the balance map
snapshot.ts            Snapshot creation, (de)serialization, persistence, comparison, and the full rebuild
stats.ts               Snapshot supply and holder analysis, plus the large-holder check
indexer.ts             Rate-event query
exclusions.ts          Addresses filtered from algoquarter accrual
constants.ts           Mainnet constants
types.ts               Plugin types
```

## Checking the work

`pnpm verify-talgo-aq` recomputes an archived window and diffs it against the manifest the retired CLI produced for it (`data/talgo/`, at the package root) — the regression check that the in-process engine still agrees with what was ingested on chain.

`TalgoPipelinePlugin.verifyAgainstChain()` replays from the newest snapshot to the current round and diffs every holder against live asset balances.

## Design notes

- **Fixed rate: one per committee window.** `effectiveMicroAlgo = (talgo + stalgo) × tAlgoRate / RATE_SCALER`, where `tAlgoRate` is the first `rate_update(uint64)` ARC-28 event emitted by the tALGO app in `[periodStart, periodEnd)`. This is an approximation of reality — tALGO/ALGO drifts upward ~0.4%/month as staking rewards accrue, so the error is ~1.3% over a typical 3M-round window. Intentional: the rate is symmetrical across all holders and avoids continuous-rate complexity. The error does not compound (the rate is re-fetched each window). A two-rate interpolation could halve it if ever needed.
- **stALGO counts 1:1 with tALGO.** Correct by design: the staking contract mints and redeems at strict parity, and rewards are paid in TINY tokens, so the underlying tALGO position never changes size. Re-stakers lose no credit.
- **Exclusions at output time only.** Non-eligible addresses (e.g. app escrows) stay in the snapshot under `excluded` so total supply can always be verified against chain metadata; they are only omitted from algoquarter accrual. See [`exclusions.ts`](exclusions.ts).
- **AQ is for depositors, not committee members.** The committee's members are the escrows; the accounts that earn AlgoQuarters are the people holding tALGO. So `calculateCommitteeAQ` scopes by round window only, and never filters against the committee's gov list.
