# Reti pipeline

Algohours for stakers in [Réti open pooling](https://github.com/algorandfoundation/reti) pools. A validator can run many staking pools; stakes are plain ALGO, so no rate conversion is involved.

## Files

Snapshot `snapshots/reti/<round>.json`:

```json
{
  "round": 62000000,
  "timestamp": 1781041146,
  "pools": { "2714622967": { "AAAA…": { "balance": "1244143182", "entryRound": 47906279 } } }
}
```

Algohours files follow the shared schema with `protocol: "reti"` and no `rate`. Per-account algohours are summed across all pools a staker is in.

## Code structure

```text
snapshot.ts            Snapshot CLI — event replay from registry creation to a target round
algohours.ts           Algohours CLI — window scan, algohour computation, next snapshots
verify.ts              Live check — replay vs current stakers boxes and registry total
compute.ts             Time-weighted stake accrual
ledger.ts              Applies events to pool staker state; epoch reward split
events.ts              ARC-28 event decoding for the ValidatorRegistry
indexer.ts             Event scan and epoch-length lookups
constants.ts           Mainnet constants
types.ts               Pipeline types
snapshot/
└── operations.ts      Snapshot creation, (de)serialization, persistence, comparison
```

## Design notes

- **Event replay instead of box reads.** Staker balances live in each pool's `stakers` box, which the Indexer only serves at the current round. Past state is rebuilt by replaying the ValidatorRegistry's ARC-28 events — stake adds (every add resets the staker's `entryRound`), stake removals, and epoch reward payouts.
- **Epoch rewards are recomputed with the contract's own split.** The `epochRewardUpdate` event carries only the credited total (`algoAdded`), not the reward the contract divided — that value is the pool account's available ALGO balance at the payout instant and is never stored on-chain. It is recovered by binary search (as `algoAdded` grows with it), then split exactly as the contract does: stakers who joined mid-epoch get a share reduced by their time in the pool, and what they leave behind goes to full-epoch stakers. Every full unstake audits this replay: the event's amount must match the rebuilt balance within a small residue, or the run throws.
- **Verification.** `pnpm verify:reti` replays each pool to the round its live box was served at and compares balances and entry rounds staker by staker; the registry's protocol-wide `staked` total is checked separately to catch any missed events. Per-staker balances may drift by a few microALGO: several reward values credit the same total while placing single microALGOs on different stakers, so the exact placement is not always recoverable.
