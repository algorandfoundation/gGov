# Frac Delegation Pipeline

From a given committee:

- Calculates the pro-rated share stake of users participating in pooled staking protocols.
- Prepares the contracts for the next voting period (intstance creation, escrow registration).
- Updates the fractional delegation contracts with the latest committee pooled voting data.

## Stages

1. **Instance upsert** - recognize the committee's escrows through the source plugins, then create the
   instances they imply on the frac registry and register the escrows to them.
2. **gGov delegation upsert** - point every escrow's gGov delegation at the instance app that holds it,
   so the instance can cast its pooled votes.
3. **AQ calculation+ingest** - for every instance whose AlgoQuarters ledger for the committee is not
   already complete, calculate the AlgoQuarters its source's depositors earned over the committee's
   window, and write them onto the instance, as the operator.

All three sources calculate AlgoQuarters — see [`src/plugins/talgo`](src/plugins/talgo/README.md),
[`src/plugins/xalgo`](src/plugins/xalgo/README.md) and [`src/plugins/reti`](src/plugins/reti/README.md),
over the shared scan and snapshot primitives in [`src/aq`](src/aq/README.md).

Stage 3 groups by source, not by instance: a source's ledgers are read first and only the instances
still needing AQ go to its plugin, in one call. A source whose instances are all complete is skipped
before its plugin is even constructed, so a re-run costs nothing. This matters for reti, the only
multi-instance source — one instance per validator, one window scan for all of them, sliced per
instance by the pools that instance holds in the committee.

### What stage 3 needs

- **A closed window.** AlgoQuarters are replayed over `[periodStart, periodEnd)`, so every round of
  the window has to be on chain (on the discovery network, i.e. mainnet). The xALGO and reti plugins
  refuse a window that is still open rather than replay it as far as the chain goes and write
  boundary snapshots with state that is not final; the tALGO plugin does not check yet — do not run
  it on an open window.
- **ALGO on the operator.** Ingesting an account costs box MBR on two app accounts: 6,900 µALGO on
  the instance (its `accountAq` box) and, on the frac registry, 19,700 µALGO for an account it has
  never seen or 800 µALGO for a known account joining an instance it was not in yet (one more
  instance id in its box; an account already linked costs nothing). `uploadAqFile` pre-computes
  both shortfalls and, with `autoFund` (which the pipeline sets), tops the apps up from the
  operator. Order of magnitude: xALGO brings ~8,000 accounts per committee, i.e. ~220 ALGO of MBR
  per run; tALGO ~2,700 accounts, ~70 ALGO. Reti spreads its stakers over one instance per
  validator, so its cost scales with how many validators the committee brings and how many stakers
  each one has. Leftover MBR stays on the apps and is recoverable via `withdrawALGO`.
- **Time and memory.** A committee window is ~3M rounds of transfers (reti: registry events) held in
  memory (hence the 8 GB heap), starting from the snapshot at `periodStart` under
  `snapshots/<source>/`. With the snapshot and the xALGO escrow cache committed, a window takes
  minutes; without them the cold rebuild from protocol creation comes first (~13 minutes for xALGO,
  see its README).

The ingest is resumable and idempotent: a run interrupted part-way (an unfunded app, a dropped
connection) finishes on the next run, which detects the accounts already on chain and ingests the
remainder — nothing is double-counted, and a manifest that disagrees with the open ledger is refused.

## Test run

Fetches real escrows and staking data from mainnet (or whatever is on `.env.test`). Writes on localnet.

```bash
pnpm seed-localnet-data # reset localnet, deploy both registries, upload the first committee
pnpm test-pipeline      # stages 1-3 for it
pnpm add-committee      # upload the second committee
pnpm test-pipeline
```

The seed funds the deployer — admin and operator of both registries — with 1,500 ALGO, enough for
the instance creations plus the AQ ingest of every source in the first committee (see _What stage 3
needs_). Its committee spans rounds `60,000,000–63,000,000`: the `60000000` snapshot of all three
sources and the xALGO escrow cache are committed, so a first `test-pipeline` runs stage 3 in a few
minutes and ingests them all — on 2026-08-19/20: Tinyman tALGO 2,654 accounts / 40,632,134 AQ, Folks
xALGO 8,130 accounts / 275,523,604 AQ, Reti #1 222 / 2,696,026 and Reti #2 171 / 574,877.

The seed's third validator, `Reti #15`, holds two pools that carried no stake over the window, so it
ends up with no eligible account and nothing to ingest — reported separately from a source that has
no AQ engine at all. An instance in that state never opens a ledger, so it stays pending and its
source recomputes on every run: whether anyone qualified is only knowable by scanning the window.

Each run also writes the boundary snapshots inside the window it scanned, so the next committee's
`periodStart` snapshot is normally already there. `add-committee` advances the window by 3M rounds
(`63,000,000–66,000,000` first): until mainnet has passed its `periodEnd`, that window is open and
stage 3 cannot run for it — the xALGO plugin throws, and tALGO must not be run either (see above).
Stages 1 and 2 still exercise the new committee's escrows.

Tweak `SOURCES` on `add-committee.ts` to dictate which escrows will be added on next committee, then:

```bash
pnpm add-committee      # upload third committee
pnpm test-pipeline
...
```

## Full run — production mirror

The test run above works a synthetic committee. This one mirrors production: it uploads the real
committee file for the latest closed mainnet window — currently
[`61000000-64000000.json`](../common/committee-files/61000000-64000000.json), 1,651 members — so
the committee id is production's, discovery finds exactly the escrows the real committee contains,
and stage 3 ingests the window's real AlgoQuarters.

```bash
pnpm seed-full-instances                       # reset localnet, deploy registries, upload the committee, stages 1-3
pnpm seed-full-instances <committee-file>      # same, for a different committee file
```

It is resumable end to end: run it again after an interruption and, as long as
`.localnet-seed.json` still names this committee on a live localnet, it skips the reset and both
the committee upload and the pipeline finish what is left. Any other seed state is replaced with a
full reset. The window must be closed on mainnet (checked up front) and the window-start snapshots
under `snapshots/` must exist — `61000000` for tALGO and xALGO is committed. The deployer is topped
up to 3,000 ALGO per run: the real committee brings the member-ingest MBR (~66 ALGO), every
instance creation — which also lands ~0.9 ALGO of creator-side MBR on the frac registry app itself,
so that app is topped up too (62 instances overran its 50 ALGO deploy funding) — and the full AQ
ingest of tALGO + xALGO (see _What stage 3 needs_).

## Voting periods

Nothing in the pipeline creates a gGov period, so neither run above leaves one behind.
`seed-periods` adds three, in the same shape the frontend seed builds
(`ggov-frontend/scripts/deploy-sample-data.ts`): an ended election, an active two-election period
and an upcoming standard vote, each `syncPeriod`-ed onto every instance holding the committee's
snapshot.

```bash
pnpm seed-periods                    # for the committee .localnet-seed.json names
pnpm seed-periods <committee-id>     # for another committee already on the gGov registry
```

Nothing votes: this committee's escrows and AlgoQuarters holders are real mainnet accounts and none
of them can sign here, unlike the frontend seed's generated ones. What it exercises is the operator
half — create, topics, ready, sync — against the instances' real escrow counts. An instance whose AQ
was skipped (no eligible account, or a source with no AQ engine) never had `syncCommittee` run for
the committee, so it is reported as not synced and left alone.

Each run appends a new set of periods rather than editing the last: `setReady` freezes a period, and
the ended one is created with a window already in the past. Every instance is topped up to 3 ALGO of
headroom first — `syncPeriod`'s boxes are paid by the instance app, which (unlike `vote`) has no
`checkNeedMBR` path to pull a top-up from the registry, and the AQ ingest leaves it sitting at
exactly its MBR. Three periods cost it ~0.5 ALGO at these shapes.

## Checking the numbers

```bash
pnpm verify-talgo-aq                 # recompute an archived tALGO window and diff it against the manifest it produced
pnpm verify-reti-aq                  # same for reti, through the whole-protocol (unsliced) path
pnpm xalgo-aq 60000000 63000000      # dry run of an xALGO window: totals and top accounts, nothing ingested
pnpm verify-talgo-balances           # replay vs live chain balances
pnpm verify-xalgo-balances           # same for xALGO, plus escrow owners vs live Folks local state
pnpm verify-reti-balances            # same for reti: every pool's stakers box, and the registry's staked total
```

All read mainnet and touch no contracts. The two `verify-*-aq` checks and `xalgo-aq` chain the
window's boundary snapshots under `snapshots/<source>/` (verifying the committed ones rather than
rewriting them), and `xalgo-aq` also writes the escrow cache; the rest write nothing. See
[`src/plugins/talgo`](src/plugins/talgo/README.md), [`src/plugins/xalgo`](src/plugins/xalgo/README.md)
and [`src/plugins/reti`](src/plugins/reti/README.md).
