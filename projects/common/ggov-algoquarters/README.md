# ggov-algoquarters

Computes per-account **AlgoQuarters** from Indexer history: ALGO-equivalent stake, weighted by rounds held. Serves to quantify gGov voting power for ALGO stakers participating in consensus through liquid-staking or pooling protocols.

**1 algoquarter (AQ) = 1 ALGO staked for 3M rounds**

Two pipelines: tinyman (tALGO/stALGO holders) and reti (Réti open pooling stakers). Output is deterministic JSON: anyone with Indexer access can reproduce it.

## Usage

Every command comes per protocol: `snapshot:<protocol>`, `algoquarters:<protocol>`, `verify:<protocol>`.

```bash
pnpm install

# 1. Reconstruct the initial balance snapshot into ./snapshots/reti
pnpm snapshot:reti 60000000

# 2. Compute algoquarters for a committee window into ./data/reti
pnpm algoquarters:reti 60000000 63000000
# ^ also writes boundary snapshots 61000000, 62000000, 63000000

# Next committee window — its start snapshot was produced by step 2
pnpm algoquarters:reti 61000000 64000000
```

The tinyman pipeline works the same way with `snapshot:tinyman` / `algoquarters:tinyman`.

Re-running a command is safe: existing snapshots are verified against the re-scan, never overwritten, and a mismatch aborts the run before any output is written.

Flags (`--check`, `--inspect`, `--no-snapshot`, …) are documented in the header comments of each entrypoint.

### Live verification

The snapshots can be compared against live chain state:

```bash
pnpm verify:reti
pnpm verify:tinyman
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

Tests run on made-up history and on the committed `snapshots/` and `data/` files — no Indexer needed. Core invariant: all algoquarters together equal the total stake summed over the window's rounds, within per-account flooring. See [`test/`](test/).

## Algoquarters file

`data/<protocol>/<periodStart>-<periodEnd>.json`:

```json
{
  "networkGenesisHash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "protocol": "reti",
  "periodStart": 59000000,
  "periodEnd": 62000000,
  "totalAccounts": 2936,
  "totalAlgoQuarters": "611283604",
  "accounts": [{ "account": "222F4J…", "algoQuarters": "39492" }]
}
```

`accounts` holds eligible holders only, sorted by address ascending (codepoint order, matching the committee-file convention). `algoQuarters` and `totalAlgoQuarters` are integer AQ. Tinyman files also carry a `rate` field (see its [README](./src/tinyman/README.md)).

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
data/{tinyman,reti}/       Algoquarters files
```

## Design notes

- **Forward replay from protocol creation.** Balances are rebuilt by replaying each protocol's full history (ASA transfers for tinyman, registry events for reti) from its creation round — no dependency on present-day chain state. Replay order is deterministic (round, then position within the block), so identical inputs produce byte-identical committed JSON.
- **Round semantics.** A snapshot at round `R` is the state after all transactions in rounds `< R` — i.e. just before round `R` executes. Windows are `[periodStart, periodEnd)`, so the end round belongs to the next window.
- **How algoquarters accrue.** An account earns `balance × rounds`: whenever its balance changes, the ALGO-equivalent balance it held since the previous change is multiplied by the rounds elapsed, and added to its running total. At the end of the window every account is settled up to `periodEnd`. All arithmetic is exact bigint microALGO·rounds; each account is floored once, at the final conversion to AQ.
- **The unit is the eligibility cutoff.** Accounts flooring below 1 AQ are omitted from the output — no dust entries. Each value is asserted to fit the uint32 per-account slot of the on-chain storage schema.
- **Fail loud.** The replay throws whenever the chain data and the rebuilt state stop adding up (a balance would go negative, a close-out or full unstake doesn't match).

Protocol specifics: [`src/tinyman/README.md`](src/tinyman/README.md) · [`src/reti/README.md`](src/reti/README.md)
