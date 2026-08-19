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
3. **AQ calculation+ingest** _(pending)_ - each committee member's AlgoQuarters, per instance. Write that AQ onto the instances, as the operator.

## Test run

Fetches real escrows and staking data from mainnet (or whatever is on `.env.test`). Writes on localnet.

```bash
pnpm seed-localnet-data # deploy contracts and uploads first committee
pnpm test-pipeline
pnpm add-committee      # upload second committee
pnpm test-pipeline
```

Tweak `SOURCES` on `add-committee.ts` to dictate which escrows will be added on next committee, then:

```bash
pnpm add-committee      # upload third committee
pnpm test-pipeline
...
```
