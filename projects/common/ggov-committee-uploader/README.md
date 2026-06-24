# ggov-committee-uploader

Builds and uploads **gGov committees** derived from the published **xGov committees**
served at <https://xgov-committees.algorand.tech/>.

## How a gGov committee is derived

For each governance period the xGov host publishes, under the network path
`mainnet-v1.0-wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8_`:

- a **committee** file — `committee/<from>-<to>.json` — the finalised xGov
  committee, including metadata (`networkGenesisHash`, `periodStart`,
  `periodEnd`, `registryId`, …);
- a **candidate committee** file — `candidate-committee/<from>-<to>.json` — a
  flat `{ address: votes }` map of everyone eligible for that period.

A gGov committee combines the two:

| gGov committee field          | Source                                          |
| ----------------------------- | ----------------------------------------------- |
| `xGovs` (members)             | the xGov **candidate** committee map            |
| `networkGenesisHash`          | the xGov committee file                         |
| `periodStart` / `periodEnd`   | the xGov committee file                         |
| `registryId`                  | **placeholder `1`** (mainnet gGov registry TBD) |
| `totalMembers` / `totalVotes` | recomputed from the candidate members           |

Members are sorted by address ascending; fields are emitted in the canonical
xGov order so the committee id (`sha512_256` over `JSON.stringify`, per
ARC-0086) is reproducible.

The list of available periods comes from `committee/index.json`.

## Usage

```bash
pnpm install

# 1. Build committee files into ./committees
pnpm build                      # all periods in the index
pnpm build 59000000-62000000    # specific period(s), by "from-to"
pnpm build 62000000             # ...or by toRound

# 2. Upload built files to the GGovRegistry app
pnpm upload                                       # all files in ./committees
pnpm upload committees/59000000-62000000.json     # specific file(s)
```

`pnpm upload` resolves the network and the `DEPLOYER` account from the standard
AlgoKit environment (`ALGOD_*`, `INDEXER_*`, `DEPLOYER_MNEMONIC`, …). The
deployer must be the registry operator. The registry app id is looked up by
creator + name `"GGovRegistry"`, or set `GGOV_REGISTRY_APP_ID` to override.

### Overrides (build)

| Env            | Default                                                     |
| -------------- | ----------------------------------------------------------- |
| `REGISTRY_ID`  | `1`                                                         |
| `BASE_URL`     | `https://xgov-committees.algorand.tech`                     |
| `NETWORK_PATH` | `mainnet-v1.0-wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8_` |
