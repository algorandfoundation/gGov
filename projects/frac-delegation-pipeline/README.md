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

Only tALGO calculates AlgoQuarters today — see [`src/plugins/talgo`](src/plugins/talgo/README.md).
Reti and xALGO are recognized as escrows in stage 1 but answer stage 3 with nothing, so their
instances are reported and skipped.

## Test run

Fetches real escrows and staking data from mainnet (or whatever is on `.env.test`). Writes on localnet.

Stage 3 reads a lot of mainnet history: a committee window is ~3M rounds of asset transfers, held in
memory, which is why the scripts run with an 8 GB heap. It starts from the balance snapshot at the
window's `periodStart` under `snapshots/talgo/`; when that one is missing it is rebuilt from asset
creation first, which takes considerably longer than the run itself.

```bash
pnpm seed-localnet-data # deploy contracts and uploads first committee
pnpm test-pipeline
pnpm add-committee      # upload second committee
pnpm test-pipeline
```

Each run also writes the boundary snapshots inside the window it scanned, so the next committee's
`periodStart` snapshot is normally already there.

Tweak `SOURCES` on `add-committee.ts` to dictate which escrows will be added on next committee, then:

```bash
pnpm add-committee      # upload third committee
pnpm test-pipeline
...
```

## Checking the tALGO numbers

```bash
pnpm verify-talgo-aq   # recompute an archived window and diff it against the manifest it produced
```

Reads mainnet, writes nothing. See [`src/plugins/talgo`](src/plugins/talgo/README.md).
