# reti plugin

AlgoQuarters for stakers in [Réti open pooling](https://github.com/algorandfoundation/reti) pools.
A validator can run many staking pools; stakes are plain ALGO, so no rate conversion is involved.

The plugin covers both halves of the source: it recognizes reti's escrows — every validator's
staking pool app accounts — for stage 1, and computes each staker's AlgoQuarters over a committee
window for stage 3. It builds on the shared scan and snapshot primitives in
[`src/aq`](../../aq/README.md).

## The only multi-instance source

One frac instance per **validator**, named `Reti #<validatorId>`, and one committee can imply dozens
of them. That shapes everything here:

- **One scan, many instances.** The ValidatorRegistry logs every balance change in the protocol, so
  the window is scanned once, replayed once, and the resulting accrual is sliced per instance.
  `calculateCommitteeAQ` is called once for the source with every instance still needing AQ, not once
  per instance.
- **Accrual is keyed by (pool, staker), and returned unfloored.** The pool a stake sits in decides
  which instance it backs, so where the floor lands is the caller's decision, over the pool set it is
  scoped to. See [`compute.ts`](compute.ts).
- **An instance is scoped to its own committee pools.** `instance.escrowAddresses` resolved back to
  pool app ids — the validator's pools _that are in this committee_. Stake in the same validator's
  other pools earns nothing on the instance: it backs none of the votes the instance casts.

A staker in two validators' pools therefore earns on both instances, independently, and each figure
is smaller than the protocol-wide total they would have had. Flooring per instance is also lossy
where the aggregate was not: 0.6 AQ in each of two pools is 1 AQ protocol-wide and 0 on either
instance.

## Snapshots

A snapshot at round `R` holds every staker's position in every pool after all transactions in rounds
`< R`. It is what a window starts from, so `[periodStart, periodEnd)` only scans its own rounds
instead of all of history.

`snapshots/reti/<round>.json`, at the package root:

```json
{
  "round": 62000000,
  "pools": { "2714622967": { "AAAA…": { "balance": "1244143182", "entryRound": 47906279 } } }
}
```

They are committed, and the only files this plugin writes. A run over `[periodStart, periodEnd)`
verifies or creates one at every 1M-round boundary inside the window, so the next committee's start
snapshot is normally one the previous run produced. Verification comes first: a stored snapshot that
disagrees with a fresh replay throws before any AQ figure is returned.

When `periodStart` has no snapshot at all, `buildSnapshot` rebuilds it by scanning from the
registry's creation round. That is minutes of Indexer work, and the reason the files are committed.

A window that is not over yet is refused outright: replaying it as far as the chain goes would write
boundary snapshots holding state that is not final, and every later window starts from those.

## Overrides

Passed through the plugin's `overrides` argument:

| Override        | Default                    |                                                                |
| --------------- | -------------------------- | -------------------------------------------------------------- |
| `registryAppId` | mainnet ValidatorRegistry  | The registry escrows are discovered from and events scanned on |
| `snapshotsDir`  | `<package>/snapshots/reti` | Where snapshots are read and written                           |

## Code structure

```text
index.ts               The plugin — escrow recognition, calculateCommitteeAQ, the whole-protocol path,
                       buildSnapshot, verifyAgainstChain
compute.ts             Per-(pool, staker) stake accrual, and the flooring the callers choose
ledger.ts              Applies events to pool staker state; epoch reward split
events.ts              ARC-28 event decoding for the ValidatorRegistry
snapshot.ts            Snapshot creation, (de)serialization, persistence, comparison, and the full rebuild
indexer.ts             Event scan and epoch-length lookups
verify.ts              Live check — replay vs current stakers boxes and registry total
constants.ts           Mainnet constants
types.ts               Plugin types
```

## Checking the work

`pnpm verify-reti-aq` recomputes an archived window through the **whole-protocol** path — every pool
of every validator, floored once per staker — and diffs it against the manifest the retired CLI
produced for it. That path exists precisely so this check can be exact: accrual is linear, so summing
every pool's unfloored microALGO-rounds and flooring once has to reproduce the old
aggregate-then-floor numbers to the AlgoQuarter. Any difference means the replay itself moved.

`RetiPipelinePlugin.verifyAgainstChain()` (`pnpm verify-reti-balances`) replays from the newest
snapshot to the current round and diffs every pool against its live `stakers` box.

## Design notes

- **Event replay instead of box reads.** Staker balances live in each pool's `stakers` box, which the
  Indexer only serves at the current round. Past state is rebuilt by replaying the ValidatorRegistry's
  ARC-28 events — stake adds (every add resets the staker's `entryRound`), stake removals, and epoch
  reward payouts.
- **Registry-wide scan, not per pool.** Querying `application-id=<poolAppId>` does return exactly
  that pool's registry-logged events, so a single-instance recompute is possible. The window scan is
  still registry-wide, because that is what keeps one snapshot chain whole for the whole protocol —
  and because slicing at compute time costs nothing once the replay has run.
- **Epoch rewards are recomputed with the contract's own split.** The `epochRewardUpdate` event
  carries only the credited total (`algoAdded`), not the reward the contract divided — that value is
  the pool account's available ALGO balance at the payout instant and is never stored on-chain. It is
  recovered by binary search (as `algoAdded` grows with it), then split exactly as the contract does:
  stakers who joined mid-epoch get a share reduced by their time in the pool, and what they leave
  behind goes to full-epoch stakers. Every full unstake audits this replay: the event's amount must
  match the rebuilt balance within a small residue, or the run throws.
- **No exclusion list.** Pool escrows hold the ALGO but never appear as stakers, and validator
  commission is paid out directly — so unlike the liquid-staking sources, nothing has to be filtered
  out of accrual.
- **Live verification tolerates a few microALGO.** Per-staker balances may drift: several reward
  values credit the same total while placing single microALGOs on different stakers, so the exact
  placement is not always recoverable. Entry rounds are compared exactly, and the registry's
  protocol-wide `staked` total is checked separately to catch any missed events.
