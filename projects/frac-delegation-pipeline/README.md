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

tALGO and xALGO calculate AlgoQuarters today — see [`src/plugins/talgo`](src/plugins/talgo/README.md)
and [`src/plugins/xalgo`](src/plugins/xalgo/README.md). Reti is recognized as escrows in stage 1 but
answers stage 3 with nothing, so its instances are reported and skipped.

### What stage 3 needs

- **A closed window.** AlgoQuarters are replayed over `[periodStart, periodEnd)`, so every round of
  the window has to be on chain (on the discovery network, i.e. mainnet). The xALGO plugin refuses a
  window that is still open rather than replay it as far as the chain goes and write boundary
  snapshots with state that is not final; the tALGO plugin does not check yet — do not run it on an
  open window.
- **ALGO on the operator.** Ingesting an account costs box MBR on two app accounts: 6,900 µALGO on
  the instance (its `accountAq` box) and, on the frac registry, 19,700 µALGO for an account it has
  never seen or 800 µALGO for a known account joining an instance it was not in yet (one more
  instance id in its box; an account already linked costs nothing). `uploadAqFile` pre-computes
  both shortfalls and, with `autoFund` (which the pipeline sets), tops the apps up from the
  operator. Order of magnitude: xALGO brings ~8,000 accounts per committee, i.e. ~220 ALGO of MBR
  per run; tALGO ~2,700 accounts, ~70 ALGO. Leftover MBR stays on the apps and is recoverable via
  `withdrawALGO`.
- **Time and memory.** A committee window is ~3M rounds of asset transfers held in memory (hence the
  8 GB heap), starting from the balance snapshot at `periodStart` under `snapshots/<source>/`. With
  the snapshot and the xALGO escrow cache committed, a window takes minutes; without them the
  cold rebuild from asset creation comes first (~13 minutes for xALGO, see its README).

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
needs_). Its committee spans rounds `60,000,000–63,000,000`: the tALGO and xALGO snapshots for
`60000000` and the xALGO escrow cache are committed, so a first `test-pipeline` runs stage 3 in a
few minutes and ingests both — on 2026-08-19: Tinyman tALGO 2,654 accounts / 40,632,134 AQ and Folks
xALGO 8,130 accounts / 275,523,604 AQ.

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
pnpm test-full-run                       # reset localnet, deploy registries, upload the committee, stages 1-3
pnpm test-full-run <committee-file>      # same, for a different committee file
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

## Checking the numbers

```bash
pnpm verify-talgo-aq                 # recompute an archived tALGO window and diff it against the manifest it produced
pnpm xalgo-aq 60000000 63000000      # dry run of an xALGO window: totals and top accounts, nothing ingested
pnpm verify-talgo-balances           # replay vs live chain balances
pnpm verify-xalgo-balances           # same for xALGO, plus escrow owners vs live Folks local state
```

All read mainnet and touch no contracts; `xalgo-aq` writes the window's snapshots and the escrow
cache under `snapshots/xalgo/`, the rest write nothing. See [`src/plugins/talgo`](src/plugins/talgo/README.md)
and [`src/plugins/xalgo`](src/plugins/xalgo/README.md).
