# Project Summary

pnpm monorepo for an Algorand xGov voting delegation system. Three core smart contracts (delegator + GGov registry + per-period GGov app), three SDKs, two React frontends, and shared resources.

## Workspace Layout

```
xgov-delegator/
  .algokit.toml              # workspace config; build order: contracts -> ggov-registry-sdk -> delegator-sdk -> ggov-sdk
  pnpm-workspace.yaml        # packages: projects/*
  projects/
    contracts/               # PuyaTs smart contracts
    ggov-registry-sdk/       # SDK for GGovRegistry (committee oracle + operator + delegations + period factory)
    ggov-sdk/                # Higher-level SDK combining registry + per-period operations
    delegator-sdk/           # SDK for delegator contract
    frontend/                # Legacy React + Vite frontend (oracle viewer)
    ggov-frontend/           # Current React + Vite + Tailwind frontend for gGov
    common/                  # Shared committee JSON files + build scripts
```

## projects/contracts

AlgoKit PuyaTs project. Contracts compile to TEAL; typed clients are auto-generated.

### Smart Contracts

| Contract | File | Purpose |
|----------|------|---------|
| `BaseContract` | `base/base.algo.ts` | Abstract base: admin checks, `increaseBudget()` |
| `EmptyContract` | `base/base.algo.ts` | Empty contract used for budget increases |
| Account ID mixin | `base/account-id.algo.ts` | Assigns uint32 IDs to addresses (saves 28 bytes/ref) |
| `Delegator` | `delegator/delegator.algo.ts` | Main delegator: internal voting (algohours) + external delegated xGov votes, proposal voting |
| `GGovRegistryContract` | `ggov-registry/ggovRegistry.algo.ts` | Committee oracle + operator + delegations + period factory (spawns ggov-period apps) |
| `GGovRegistryAccountContract` | `ggov-registry/ggovRegistryAccount.algo.ts` | Account management base for the registry |
| `GGovPeriodContract` | `ggov-period/ggovPeriod.algo.ts` | One app per voting period: topics, vote tallies, vote records, period/topic bodies |
| `XGovRegistryMock` | `xgov-registry-mock/xGovRegistryMock.algo.ts` | Mock for testing |
| `XGovProposalMock` | `xgov-proposal-mock/xGovProposalMock.algo.ts` | Mock for testing |

The registry holds the `periodId → GGovPeriodSummary` box. Each `GGovPeriod` app is created via inner-txn from the registry's `createPeriod`. The period app syncs `votingStart`/`votingEnd`/`numTopics` back to the registry on every `editPeriod` / `addTopic` via inner-call to `registry.updatePeriodSummary`, which validates the inner-call caller is the registered period app.

### Shared Contract Code

- `base/errors.algo.ts` - Centralized error constants (`ERR:CODE` format)
- `base/types.algo.ts` - Shared ARC-4 types and structs (`GGovAccount`, `GGovPeriodSummary`, `GGovTopic`, etc.)
- `base/utils.algo.ts` - Utility functions

### Tests

| File | Scope |
|------|-------|
| `base/base.algo.spec.ts` | Base contract unit tests |
| `base/account-id.algo.spec.ts` | Account ID tests |
| `delegator/delegator.algo.spec.ts` | Delegator unit tests |
| `delegator/delegator.simple.e2e.spec.ts` | Delegator simple E2E |
| `delegator/delegator.complex.e2e.spec.ts` | Delegator complex E2E |
| `ggov-registry/ggovRegistry.e2e.spec.ts` | GGovRegistry (committee oracle) E2E tests |
| `ggov-period/ggovPeriod.e2e.spec.ts` | GGovPeriod E2E: addPeriod/edit/addTopic/vote + summary-sync + trust-boundary tests |
| `common-tests.ts` | Shared test utilities (deployRegistry, createCommittee, etc.) |

### Artifacts

Per contract: `*.approval.teal`, `*.arc32.json`, `*.arc56.json`, `*Client.ts`, `*.puya.map`. Located in `smart_contracts/artifacts/<contract>/`.

### Commands

```bash
pnpm run build    # compile contracts + generate clients
pnpm run test     # vitest with coverage
```

## projects/ggov-registry-sdk

SDK for the GGovRegistry contract (the durable factory + committee oracle).

### Structure

```
src/
  index.ts                           # Exports: GGovRegistrySDK, GGovRegistryReaderSDK, GGovRegistryFactory, GGovRegistryClient, calculateCommitteeId
  sdk.ts                             # Write SDK (extends reader): uploadCommitteeFile() orchestration, ingest/uningest, setOperator, delegate
  sdkReader.ts                       # Read-only SDK
  types.ts                           # XGovCommitteeFile, AccountWithVotes, StoredXGov, etc.
  constants.ts
  networkConfig.ts
  generated/
    GGovRegistryClient.ts            # Auto-generated typed client (copied from contracts artifacts)
    errors.ts                        # Auto-generated error map
  util/
    chunk.ts, chunked.ts, comitteeId.ts, increaseBudget.ts,
    requiresSender.ts, wrapErrors.ts, types.ts
examples/
  get.ts, upload.ts                  # Round-trip committee writes/reads against a localnet registry
```

### Build

Prebuild copies client from contracts artifacts + generates error map, then tsc to `dist/`.

## projects/ggov-sdk

Higher-level SDK that **composes** the registry SDK and adds per-period orchestration. User-facing surface preserved across the split.

```
src/
  index.ts                           # Exports: GGovSDK, GGovReaderSDK + re-exports from ggov-registry-sdk
  sdk.ts                             # Write SDK: addPeriod (registry inner-txn create), per-period writes (editPeriod, addTopic, vote, ...)
  sdkReader.ts                       # Reader: composes GGovRegistryReaderSDK; per-period client cache; routes reads to period apps
  types.ts                           # Constructor args + body JSON helpers
  networkConfig.ts                   # ggovRegistryAppId (deprecated alias: ggovAppId)
  generated/
    GGovRegistryClient.ts            # Registry client
    GGovPeriodClient.ts              # Period client
    errors.ts
examples/
  add-period.ts                      # End-to-end: deploy registry → setOperator → uploadCommittee → addPeriod → addTopic
```

## projects/delegator-sdk

SDK for the delegator contract. Same architecture.

## projects/ggov-frontend

React 19 + Vite + TailwindCSS + DaisyUI. Current frontend for gGov.

### Key Files

- `src/hooks/useGGovSDK.ts` — reads `VITE_GGOV_REGISTRY_APP_ID` env var, constructs `GGovSDK` / `GGovReaderSDK`
- `src/hooks/queries.ts`, `src/hooks/mutations.ts` — React Query bindings to the SDK
- `scripts/deploy-sample-data.ts` — Deploys a registry + sets operator + seeds sample periods
- `scripts/print-committees.ts` — Diagnostic script

## projects/frontend (legacy)

Older oracle viewer; still uses generated clients for `Delegator`. Mostly inactive.

## projects/common

- `committee-files/` - Committee JSON data
- `sdks/generate-errors.ts` - Parses `errors.algo.ts` and generates SDK error maps

## Build Pipeline

1. Compile contracts (PuyaTs → TEAL) + generate typed clients into `artifacts/`
2. Copy clients into SDK `generated/` folders (`prebuild` step)
3. Generate error maps from `errors.algo.ts`
4. Build SDKs (tsc → `dist/`)
5. Frontends consume linked workspace packages

Full workspace build: `algokit project run build` (respects `.algokit.toml` build order)

## Key Patterns

- **Registry-as-factory**: One durable `GGovRegistry` app; each voting period is a separate `GGovPeriod` app spawned via inner-txn. Registry is the trust root for committees, operator identity, and delegations.
- **Period summary mirror**: Registry holds `periodId → { appId, votingStart, votingEnd, numTopics }`. Period contract mirrors edits back via `registry.updatePeriodSummary` (gated on `Global.callerApplicationId === storedAppId`). One round trip lists all periods.
- **Account ID system**: uint32 IDs assigned to addresses to save storage (28 bytes/ref).
- **Superbox**: Efficient large-array box storage via `@d13co/superbox`.
- **Reader/Writer SDK split**: Separate classes for read-only vs write operations.
- **Generated + hand-written**: Clients auto-generated, SDK logic hand-written on top.
- **Error wrapping**: Contract `ERR:CODE` constants → SDK human-readable messages.
- **Budget management**: `increaseBudget()` calls via empty contract for complex operations (e.g. vote re-tally).
