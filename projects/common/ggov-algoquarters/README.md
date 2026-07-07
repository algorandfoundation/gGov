# ggov-algohours-calculator

Computes per-account **algohours** — time-weighted ALGO-equivalent staked holdings — by replaying on-chain history from the Indexer. Two pipelines: **tinyman** (tALGO/stALGO holders) and **reti** (Réti open pooling stakers). Output is deterministic JSON: anyone with Indexer access can reproduce it.

1 algohour = 1 ALGO staked for 1 hour

## Usage

Every command comes per protocol: `snapshot:<protocol>`, `algohours:<protocol>`, `verify:<protocol>`.

```bash
pnpm install

# 1. Reconstruct the initial balance snapshot into ./snapshots/tinyman
pnpm snapshot:tinyman 60000000

# 2. Compute algohours for a committee window into ./data/tinyman
pnpm algohours:tinyman 60000000 63000000
# ^ also writes boundary snapshots 61000000, 62000000, 63000000

# Next committee window — its start snapshot was produced by step 2
pnpm algohours:tinyman 61000000 64000000
```

The reti pipeline works the same way with `snapshot:reti` / `algohours:reti`.

Re-running a command is safe: existing snapshots are verified against the re-scan, never overwritten, and a mismatch aborts the run before any output is written.

Flags (`--check`, `--inspect`, `--no-snapshot`, …) are documented in the header comments of each entrypoint.

### Live verification

The snapshots can be compared against live chain state:

```bash
pnpm verify:tinyman
pnpm verify:reti
```

Each replays from the latest committed snapshot and diffs the result against the chain, exiting non-zero on any difference.

### Environment

| Env              | Default                                      |
| ---------------- | -------------------------------------------- |
| `INDEXER_SERVER` | `https://mainnet-idx.4160.nodely.dev`        |
| `INDEXER_TOKEN`  | Empty; set when the Indexer requires a token |

### Tests

```bash
pnpm test
```

Tests run on made-up history and on the committed `snapshots/` and `data/` files — no Indexer needed. Core invariant: all algohours together equal total stake × time. See [`test/`](test/).

## Algohours file

`data/<protocol>/<periodStart>-<periodEnd>.json`:

```json
{
  "networkGenesisHash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "protocol": "reti",
  "periodStart": 59000000,
  "periodEnd": 62000000,
  "periodStartTime": 1772784827,
  "periodEndTime": 1781041146,
  "totalAccounts": 2957,
  "totalAlgoHours": "1401889568707852051",
  "accounts": [{ "account": "222F4J…", "algoHours": "90573560652480" }]
}
```

`accounts` holds eligible holders only, sorted by address ascending (codepoint order, matching the committee-file convention). `algoHours` and `totalAlgoHours` are in microALGO-hours (bigints as decimal strings); times are Unix seconds. Tinyman files also carry a `rate` field (see its [README](./src/tinyman/README.md)).

## Code structure

```text
src/
├── indexer.ts             Shared Indexer queries — windowed scans, ARC-28 event decoding, retries
├── snapshots.ts           Shared snapshot persistence and verify-first snapshot chaining
├── config.ts              Indexer client setup and scan configuration
├── types.ts               Shared domain types
├── utils/                 bigint-safe JSON, optional transfer log
├── tinyman/               tALGO/stALGO pipeline — see src/tinyman/README.md
└── reti/                  Reti pools pipeline — see src/reti/README.md
test/{tinyman,reti}/       Unit tests
snapshots/{tinyman,reti}/  Balance snapshots
data/{tinyman,reti}/       Algohour files
```

## Design notes

- **Forward replay from protocol creation.** Balances are rebuilt by replaying each protocol's full history (ASA transfers for tinyman, registry events for reti) from its creation round — no dependency on present-day chain state. Replay order is deterministic (round, then position within the block), so identical inputs produce byte-identical committed JSON.
- **Round semantics.** A snapshot at round `R` is the state after all transactions in rounds `< R` — i.e. just before round `R` executes. Windows are `[periodStart, periodEnd)`, so the end round belongs to the next window.
- **How algohours accrue.** An account earns `balance × time`: whenever its balance changes, the seconds since its previous change are multiplied by the ALGO-equivalent balance it held during that elapsed time, and added to its running total. At the end of the window every account is settled up to `periodEnd`. All arithmetic is exact bigint; each account is rounded once, at the final conversion to microALGO-hours.
- **Fail loud.** The replay throws whenever the chain data and the rebuilt state stop adding up (a balance would go negative, a close-out or full unstake doesn't match).

Protocol specifics: [`src/tinyman/README.md`](src/tinyman/README.md) · [`src/reti/README.md`](src/reti/README.md)
