# AlgoQuarters primitives

Per-account **AlgoQuarters** from Indexer history: ALGO-equivalent stake, weighted by rounds held.
Serves to quantify gGov voting power for ALGO stakers participating in consensus through
liquid-staking or pooling protocols.

**1 algoquarter (AQ) = 1 ALGO staked for 3M rounds**

This directory is what every source plugin has in common — the windowed Indexer scans, the
verify-first snapshot chaining, and the AQ unit itself. The protocol-specific engines build on it:
[`talgo`](../plugins/talgo/README.md) (tALGO/stALGO holders), [`xalgo`](../plugins/xalgo/README.md)
(Folks xALGO), and [`reti`](../plugins/reti/README.md) (Réti open pooling stakers).

All three used to be standalone CLIs in a `ggov-algoquarters` package that wrote manifest files for
someone to upload by hand. They now run in-process: [stage 3](../../README.md#stages) of the
pipeline calls `calculateCommitteeAQ`, gets the numbers in memory, and ingests them on chain in the
same run. No manifest file is read or written.

## Code structure

```text
index.ts             Barrel — everything the plugins import from here
indexer.ts           Windowed transaction scans, ASA transfer and ARC-28 event extraction, retries
snapshots.ts         Snapshot file persistence and verify-first snapshot chaining
config.ts            Scan window and snapshot interval
types.ts             Shared domain types
utils/               bigint-safe JSON, the AQ unit and its uint32 assertion
```

The committed artifacts each engine works from live at the package root, one directory per source:
`snapshots/<source>/` (the chained balance snapshots, read and written by the plugins) and
`data/<source>/` (a frozen archive of the windows the retired CLIs produced, which the regression
checks diff against — nothing writes there any more).

## Algoquarters file

The manifest shape the pipeline assembles and `uploadAqFile` ingests, and the shape of the archived
`data/<source>/<periodStart>-<periodEnd>.json`:

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

`accounts` holds eligible holders only, sorted by address ascending (codepoint order, matching the
committee-file convention). `algoQuarters` and `totalAlgoQuarters` are integer AQ. The liquid-staking
sources carry an extra `rate`; reti does not, its stake being native ALGO.

## Design notes

- **Forward replay from protocol creation.** Balances are rebuilt by replaying each protocol's full
  history (ASA transfers for tALGO and xALGO, registry events for reti) from its creation round — no
  dependency on present-day chain state. Replay order is deterministic (round, then position within
  the block), so identical inputs produce identical output.
- **Round semantics.** A snapshot at round `R` is the state after all transactions in rounds `< R` —
  i.e. just before round `R` executes. Windows are `[periodStart, periodEnd)`, so the end round
  belongs to the next window.
- **How algoquarters accrue.** An account earns `balance × rounds`: whenever its balance changes, the
  ALGO-equivalent balance it held since the previous change is multiplied by the rounds elapsed, and
  added to its running total. At the end of the window every account is settled up to `periodEnd`.
  All arithmetic is exact bigint microALGO·rounds; each account is floored once, at the final
  conversion to AQ.
- **The unit is the eligibility cutoff.** Accounts flooring below 1 AQ are omitted from the output —
  no dust entries. Each value is asserted to fit the uint32 per-account slot of the on-chain storage
  schema.
- **Snapshots are chained verify-first.** A run over `[periodStart, periodEnd)` verifies or creates
  a snapshot at every 1M-round boundary inside the window, so the next committee's start snapshot is
  normally one the previous run produced. A stored snapshot that disagrees with a fresh replay throws
  before anything is written — neither the snapshot nor any AQ figure derived from it is trusted.
- **Fail loud.** The replay throws whenever the chain data and the rebuilt state stop adding up (a
  balance would go negative, a close-out or full unstake doesn't match).

## Environment

The plugins read through the pipeline's discovery `AlgorandClient`, so they take their endpoints from
`ALGOD_SERVER`/`ALGOD_PORT` and `INDEXER_SERVER`/`INDEXER_PORT` the way `AlgorandClient.fromEnvironment()`
does — set both, or it resolves to localnet.
