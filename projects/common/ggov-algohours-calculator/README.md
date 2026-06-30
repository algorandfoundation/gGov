# ggov-algohours-calculator

Computes per-account algohours for **tALGO** and **stALGO** holders by scanning Algorand indexer transaction history.

## Usage

### Environment

Set `INDEXER_SERVER` (and optionally `INDEXER_TOKEN`) if not using the default public Algonode indexer (`https://mainnet-idx.4160.nodely.dev`).

### Snapshot: reconstruct balances at round

```bash
pnpm snapshot <round> [--save-transfers] [--check]
# e.g.
pnpm snapshot 60000000
```

Scans all tALGO and stALGO transfers from asset creation up to (not including) `<round>` and reconstructs every account's balance.

> **Round semantics:** `snapshot <round>` scans transfers in `[creation, round)` interval — the snapshot captures state before round `<round>` transactions execute. This matches how committee windows are defined: `[periodStart, periodEnd)` is exclusive on the right, so the boundary round itself belongs to the next period.

#### Flags

- `--save-transfers` writes every scanned transfer to `snapshots/<round>.transfers.log` for debugging/inspection.
- `--check` re-scans from genesis and diffs against the stored snapshot instead of writing a new one. Useful for verifying an existing snapshot is correct.

#### Outputs

- `snapshots/<round>.json` (except when using `--check`)
- `snapshots/<round>.transfers.log` (optional)

### Algohours: compute time-weighted voting power

```bash
pnpm algohours <periodStart> <periodEnd> [--no-snapshot] [--save-transfers]
# e.g.
pnpm algohours 60000000 63000000
```

Requires `snapshots/<periodStart>.json` to exist. By default, the command saves or
verifies every 1M-round boundary snapshot in `(periodStart, periodEnd]`.

#### Flags

- `--no-snapshot` skips saving or verifying boundary snapshots.

- `--save-transfers` writes every scanned transfer to `data/<periodStart>-<periodEnd>.transfers.log`.

#### Output

- `data/<periodStart>-<periodEnd>.json`
- `data/<periodStart>-<periodEnd>.transfers.log` (optional)
- `snapshots/<B>.json` for each 1M boundary in `(periodStart, periodEnd]` (unless using `--no-snapshot`)

### Chaining windows

Because committee periods are 3M windows sliding 1M at a time (60–63, 61–64, 62–65…),
each intermediate round also needs a snapshot. The algohours command produces all of them:

```bash
pnpm snapshot 60000000
pnpm algohours 60000000 63000000
# ^ writes 61000000.json, 62000000.json, 63000000.json

pnpm algohours 61000000 64000000
# ^ 61000000.json already exists → verified; writes 62000000.json (exists → verified), 64000000.json
```

Re-running a command is safe: existing snapshots are verified, not overwritten.

## Code structure

| File                       | Read it for…                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `src/snapshot.ts`          | Mode 1 entrypoint — full scan from genesis to a target round     |
| `src/algohours.ts`         | Mode 2 entrypoint — algohour computation over a window           |
| `src/compute-algohours.ts` | Core algorithm — time-weighted balance accumulation              |
| `src/indexer.ts`           | Algorand indexer client — windowed scan, ARC-28 rate fetch       |
| `src/ledger.ts`            | Balance replay — applies transfers to a mutable balance map      |
| `src/snapshot-file.ts`     | Snapshot serialization, storage, and comparison                  |
| `src/snapshot-stats.ts`    | Snapshot supply and holder analysis                              |
| `src/exclusions.ts`        | Which addresses are filtered from output (app escrows, LP pools) |
| `src/types.ts`             | All domain types                                                 |
| `src/config.ts`            | Indexer client setup and scan configuration                      |
| `src/constants/tinyman.ts` | Tinyman mainnet asset and application constants                  |
| `src/transfer-log.ts`      | Optional transfer-log writer                                     |
| `src/json.ts`              | JSON serialization with bigint support                           |

## Algohours output format

`data/<start>-<end>.json`:

```json
{
  "periodStart": 60000000,
  "periodEnd": 63000000,
  "periodStartTime": 1730000000,
  "periodEndTime": 1738500000,
  "rate": "1000500000000000",
  "accounts": [{ "account": "ADDR...", "algoHours": "123456789" }]
}
```

`algoHours` is in microALGO-hours (bigint as decimal string).

## Rate model

The effective ALGO value of each account is:

```ts
effectiveMicroAlgo = (talgo + stalgo) × tAlgoRate / 1_000_000_000_000
```

`tAlgoRate` comes from the first `rate_update(uint64)` ARC-28 event emitted by the tALGO contract in `[periodStart, periodEnd)`. That rate is applied to the entire window.

**stALGO is treated 1:1 with tALGO** — this is correct by design. The stALGO staking contract always mints and redeems at strict parity (N tALGO in → N stALGO out, and back). Staking rewards are distributed in TINY tokens, not as additional tALGO, so the underlying tALGO position never changes in size. There is no stALGO/tALGO exchange rate.

## Known limitations

### Liquidity pool addresses are not yet excluded

Known app escrows and reserve accounts are excluded. Tinyman LP pool escrows still need to be identified and added to `exclusions.ts` before the output is used for subdelegation allocation.

### Intra-window rate drift is neglected

`tAlgoRate` is fixed for the entire `[periodStart, periodEnd)` window. Any ALGO rewards that the consensus-staking accounts accrue during the window — causing the tALGO/ALGO rate to drift upward — are not reflected in that window's algohour computation.

This is considered acceptable per window: the drift over a single 3M-round committee window is small relative to the amounts staked.

Importantly, this approximation does **not** compound across periods. Because `tAlgoRate` is fetched independently for each window, a long-term staker's accumulated rate appreciation is captured between windows — only the marginal drift within the current window is neglected.
