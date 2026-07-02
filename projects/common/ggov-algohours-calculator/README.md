# ggov-algohours-calculator

Computes per-account **algohours** — time-weighted ALGO-equivalent holdings — for **tALGO** and **stALGO** holders, by replaying ASA transfer history from the Algorand Indexer. Output is deterministic JSON: anyone with Indexer access can reproduce it.

1 algohour = 1 ALGO staked for 1 hour

## Usage

```bash
pnpm install

# 1. Reconstruct the initial balance snapshot into ./snapshots
pnpm snapshot 60000000

# 2. Compute algohours for a committee window into ./data
pnpm algohours 60000000 63000000
# ^ also writes boundary snapshots 61000000, 62000000, 63000000

# Next committee window — its start snapshot was produced by step 2
pnpm algohours 61000000 64000000
```

Committee windows slide 1M rounds at a time (60–63, 61–64, …), so each `algohours` run saves the 1M-boundary snapshots that later windows start from. Re-running a command is safe: existing snapshots are verified against the re-scan, never overwritten. A verification mismatch aborts the run before any output is written.

Flags (`--save-transfers`, `--check`, `--inspect`, `--no-snapshot`) and output formats are documented in the header comments of the two entrypoints, [`src/snapshot.ts`](src/snapshot.ts) and [`src/algohours.ts`](src/algohours.ts).

### Environment

| Env              | Default                                      |
| ---------------- | -------------------------------------------- |
| `INDEXER_SERVER` | `https://mainnet-idx.4160.nodely.dev`        |
| `INDEXER_TOKEN`  | Empty; set when the Indexer requires a token |

### Tests

```bash
pnpm test                # run all unit tests
```

Tests run on made-up transfers and on the committed `snapshots/` and `data/` files — no Indexer needed. Some invariants:

- All algohours together equal total supply × time.
- Every committed snapshot holds the exact same total supply.

See [`test/`](test/).

## Algohours file

`data/<periodStart>-<periodEnd>.json`:

```json
{
  "networkGenesisHash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "protocol": "tinyman-consensus-staking",
  "periodStart": 60000000,
  "periodEnd": 63000000,
  "periodStartTime": 1730000000,
  "periodEndTime": 1738500000,
  "rate": "1.045000000000",
  "totalAccounts": 3871,
  "totalAlgoHours": "89424352909063151",
  "accounts": [{ "account": "222LNF…", "algoHours": "123456789" }]
}
```

`accounts` holds eligible holders only, sorted by address ascending (codepoint order, matching the committee-file convention). `algoHours` and `totalAlgoHours` are in microALGO-hours (bigints as decimal strings); `rate` is the fixed tALGO/ALGO rate for the window (12-decimal fixed-point string); times are Unix seconds.

## Code structure

```text
src/
├── snapshot.ts            Snapshot CLI — full scan from asset creation to a target round
├── algohours.ts           Algohours CLI — window scan, rate fetch, algohour computation, create next snapshots
├── compute.ts             Core algorithm — time-weighted balance accrual
├── ledger.ts              Balances mutable state — applies transfers, opt-ins, close-outs
├── indexer.ts             Indexer queries — windowed transfer scan, ARC-28 rate fetch
├── exclusions.ts          Which addresses are filtered from algohour accrual
├── config.ts              Indexer client setup and scan configuration
├── types.ts               All domain types
├── constants/
│   └── tinyman.ts         Tinyman consensus-staking constants
├── snapshot/
│   ├── operations.ts      Snapshot creation, (de)serialization, persistence, comparison
│   └── stats.ts           Snapshot supply and holder analysis
└── utils/
    ├── json.ts            bigint-safe JSON serialization
    └── transfer-log.ts    Optional transfer log for inspecting scans
test/                      Invariant unit tests (conservation, accrual, snapshots, data files)
snapshots/                 Balance snapshots
data/                      Algohour files
```

## Design notes

- **Forward scan from asset creation.** Balances are rebuilt by replaying every ASA transfer from the assets' creation rounds — no dependency on present-day chain state. The Indexer's asset-transfer search captures every balance change (inner transactions included), and the replay order is deterministic (round, then position within the block), so identical inputs produce byte-identical committed JSON.
- **Round semantics.** A snapshot at round `R` is the state after all transactions in rounds `< R` — i.e. just before round `R` executes. Windows are `[periodStart, periodEnd)`, so the end round belongs to the next window.
- **How algohours accrue.** An account earns `balance × time`: whenever its balance changes, the seconds since its previous change are multiplied by the ALGO-equivalent balance it held during that elapsed time, and added to its running total. At the end of the window every account is settled up to `periodEnd`. All arithmetic is exact bigint; each account is rounded once, at the final conversion to microALGO-hours.
- **Fixed rate: one per committee window.** `effectiveMicroAlgo = (talgo + stalgo) × tAlgoRate / RATE_SCALER`, where `tAlgoRate` is the first `rate_update(uint64)` ARC-28 event emitted by the tALGO app in `[periodStart, periodEnd)`. This is an approximation of reality — tALGO/ALGO drifts upward ~0.4%/month as staking rewards accrue, so the error is ~1.3% over a typical 3M-round window. Intentional: the rate is symmetrical across all holders and avoids continuous-rate complexity. The error does not compound (the rate is re-fetched each window). A two-rate interpolation could halve it if ever needed.
- **stALGO counts 1:1 with tALGO**. Correct by design: the staking contract mints and redeems at strict parity, and rewards are paid in TINY tokens, so the underlying tALGO position never changes size. Re-stakers lose no credit.
- **Exclusions at output time only.** Non-eligible addresses (e.g. app escrows) stay in the snapshot under `excluded` so total supply can always be verified against chain metadata; they are only omitted from algohour accrual. See `src/exclusions.ts`.
- **Fail loud.** The replay throws if a balance would go negative or a close-out doesn't add up, and a snapshot run fails if an eligible address holds >15% of circulating supply — usually an escrow or LP pool missing from `src/exclusions.ts`.
