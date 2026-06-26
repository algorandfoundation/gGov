# Project Summary

pnpm monorepo for an Algorand general governance (ggov) and gGov/xGov voting delegation system. Three core smart contracts (delegator + GGov registry + per-period GGov app), two SDKs, a React frontend, and shared resources.

## Workspace Layout

```
xgov-delegator/
  .algokit.toml              # workspace config; build order: contracts -> delegator-sdk -> ggov-sdk
  pnpm-workspace.yaml        # packages: projects/*
  projects/
    contracts/               # PuyaTs smart contracts
    ggov-sdk/                # Unified GGov SDK: registry (src/registry/) + per-period operations
    delegator-sdk/           # SDK for delegator contract
    ggov-frontend/           # React + Vite + Tailwind frontend for gGov
    common/                  # Shared committee JSON files + build scripts
```

## projects/contracts

AlgoKit PuyaTs project. Contracts compile to TEAL; typed clients are auto-generated.

### Smart Contracts

| Contract                      | File                                          | Purpose                                                                                      |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `BaseContract`                | `base/base.algo.ts`                           | Abstract base: admin checks, `increaseBudget()`                                              |
| `EmptyContract`               | `base/base.algo.ts`                           | Empty contract used for budget increases                                                     |
| Account ID mixin              | `base/account-id.algo.ts`                     | Assigns uint32 IDs to addresses (saves 28 bytes/ref)                                         |
| `Delegator`                   | `delegator/delegator.algo.ts`                 | Main delegator: internal voting (algohours) + external delegated xGov votes, proposal voting |
| `GGovRegistryContract`        | `ggov-registry/ggovRegistry.algo.ts`          | Committee oracle + operator + delegations + period factory (spawns ggov-period apps)         |
| `GGovRegistryAccountContract` | `ggov-registry/ggovRegistryAccount.algo.ts`   | Account management base for the registry                                                     |
| `GGovPeriodContract`          | `ggov-period/ggovPeriod.algo.ts`              | One app per voting period: topics, vote tallies, vote records, period/topic bodies           |
| `XGovRegistryMock`            | `xgov-registry-mock/xGovRegistryMock.algo.ts` | Mock for testing                                                                             |
| `XGovProposalMock`            | `xgov-proposal-mock/xGovProposalMock.algo.ts` | Mock for testing                                                                             |

The registry holds the `periodId → GGovPeriodSummary` box. Each `GGovPeriod` app is created via inner-txn from the registry's `createPeriod`. The period app syncs `votingStart`/`votingEnd`/`numTopics` back to the registry on every `editPeriod` / `addTopic` via inner-call to `registry.updatePeriodSummary`, which validates the inner-call caller is the registered period app.

### Shared Contract Code

- `base/errors.algo.ts` - Centralized error constants (`ERR:CODE` format)
- `base/types.algo.ts` - Shared ARC-4 types and structs (`GGovAccount`, `GGovPeriodSummary`, `GGovTopic`, etc.)
- `base/utils.algo.ts` - Utility functions

### Tests

| File                                      | Scope                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `base/base.algo.spec.ts`                  | Base contract unit tests                                                           |
| `base/account-id.algo.spec.ts`            | Account ID tests                                                                   |
| `delegator/delegator.algo.spec.ts`        | Delegator unit tests                                                               |
| `delegator/delegator.simple.e2e.spec.ts`  | Delegator simple E2E                                                               |
| `delegator/delegator.complex.e2e.spec.ts` | Delegator complex E2E                                                              |
| `ggov-registry/ggovRegistry.e2e.spec.ts`  | GGovRegistry (committee oracle) E2E tests                                          |
| `ggov-period/ggovPeriod.e2e.spec.ts`      | GGovPeriod E2E: addPeriod/edit/addTopic/vote + summary-sync + trust-boundary tests |
| `common-tests.ts`                         | Shared test utilities (deployRegistry, createCommittee, etc.)                      |

### Artifacts

Per contract: `*.approval.teal`, `*.arc32.json`, `*.arc56.json`, `*Client.ts`, `*.puya.map`. Located in `smart_contracts/artifacts/<contract>/`.

### Commands

```bash
pnpm run build    # compile contracts + generate clients
pnpm run test     # vitest with coverage
```

## projects/ggov-sdk

Unified GGov SDK. The top level is the higher-level SDK (`GGovSDK`/`GGovReaderSDK`) that **composes** the registry SDK and adds per-period orchestration; the registry SDK (formerly the separate `ggov-registry-sdk` package) lives under `src/registry/` and is re-exported from the package root, so registry symbols (`GGovRegistrySDK`, `XGovCommitteeFile`, `calculateCommitteeId`, …) import straight from `ggov-sdk`.

```
src/
  index.ts                           # Exports: GGovSDK, GGovReaderSDK + the registry surface (GGovRegistrySDK, calculateCommitteeId, ...)
  sdk.ts                             # Write SDK: addPeriod (registry inner-txn create), per-period writes (editPeriod, addTopic, vote, ...)
  sdkReader.ts                       # Reader: composes GGovRegistryReaderSDK; per-period client cache; routes reads to period apps
  types.ts                           # Constructor args + body JSON helpers
  networkConfig.ts                   # ggovRegistryAppId (deprecated alias: ggovAppId)
  registry/                          # Registry SDK (merged from ggov-registry-sdk)
    index.ts                         # Registry barrel; reuses ../generated, ../util, ../constants
    sdk.ts                           # GGovRegistrySDK: uploadCommitteeFile() orchestration, ingest/uningest, setOperator, delegate
    sdkReader.ts                     # GGovRegistryReaderSDK (read-only)
    types.ts                         # XGovCommitteeFile, AccountWithVotes, StoredXGov, registryAppId constructor args
    networkConfig.ts                 # Registry network config (mainnet/testnet registry app ids)
    xGov.ts                          # xGovToTuple helper
  generated/
    GGovRegistryClient.ts            # Registry client (shared by registry/ and top level)
    GGovPeriodClient.ts              # Period client
    errors.ts                        # Auto-generated error map
  util/
    chunk.ts, chunked.ts, comitteeId.ts, requiresSender.ts, wrapErrors.ts,
    increaseBudget.ts, txnExecutor.ts   # shared by registry/ and top level
examples/
  add-period.ts                      # End-to-end: deploy registry → setOperator → uploadCommittee → addPeriod → addTopic
  create-registry.ts                 # Minimal bootstrap: GGovSDK.createRegistry() (deploy + seed MBR + upload period approval + optional operator/xgov config)
  update-period-app.ts               # Admin-only: replace a deployed period's on-chain app code with the GGovPeriod build bundled in this SDK version
  get.ts, upload.ts, set-config.ts   # Registry round-trip committee writes/reads against a localnet registry
```

### Build

Prebuild copies both clients from contracts artifacts + generates the error map, then tsc to `dist/`.

## projects/delegator-sdk

SDK for the delegator contract. Same architecture.

## projects/ggov-frontend

React 19 + Vite + TailwindCSS + DaisyUI. Current frontend for gGov.

### Key Files

- `src/hooks/useGGovSDK.ts` — reads `VITE_GGOV_REGISTRY_APP_ID` env var, constructs `GGovSDK` / `GGovReaderSDK`
- `src/hooks/queries.ts`, `src/hooks/mutations.ts` — React Query bindings to the SDK
- `scripts/deploy-sample-data.ts` — Deploys a registry + sets operator + seeds sample periods
- `scripts/print-committees.ts` — Diagnostic script

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

## CI/CD

GitHub Actions workflows live in [`.github/workflows`](./.github/workflows).

### CI

Runs on PRs to `main` and `develop`. Contracts and SDKs are treated as one unit — a change in either triggers the test matrix.

```
audit   ─┐
         ├─► validate (format → lint → build contracts → artifact check → build SDKs → typecheck → build frontend)
changes -┤
         └─► test (matrix) — only when contracts or SDKs changed
```

### CD

| Workflow       | Deploys             | When                                               |
| -------------- | ------------------- | -------------------------------------------------- |
| `contracts-cd` | contracts (testnet) | Manual (`workflow_dispatch`)                       |
| `frontend-cd`  | frontend (testnet)  | Auto on push to main (frontend/sdk paths) + manual |
| `storybook-cd` | storybook           | Auto on push to main (frontend/sdk paths) + manual |

All actions are pinned to commit SHAs. Secrets are scoped to the step that needs them.

## Key Patterns

- **Registry-as-factory**: One durable `GGovRegistry` app; each voting period is a separate `GGovPeriod` app spawned via inner-txn. Registry is the trust root for committees, operator identity, and delegations.
- **Period summary mirror**: Registry holds `periodId → { appId, votingStart, votingEnd, numTopics }`. Period contract mirrors edits back via `registry.updatePeriodSummary` (gated on `Global.callerApplicationId === storedAppId`). One round trip lists all periods.
- **Account ID system**: uint32 IDs assigned to addresses to save storage (28 bytes/ref).
- **Superbox**: Efficient large-array box storage via `@d13co/superbox`.
- **Reader/Writer SDK split**: Separate classes for read-only vs write operations.
- **Generated + hand-written**: Clients auto-generated, SDK logic hand-written on top.
- **Error wrapping**: Contract `ERR:CODE` constants → SDK human-readable messages.
- **Budget management**: `increaseBudget()` calls via empty contract for complex operations (e.g. vote re-tally).
