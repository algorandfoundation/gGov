# gGov

General governance voting for Algorand, built around xGov committees and gGov vote delegation.

gGov is two cooperating smart contracts:

- **[`GGovRegistry`](#ggovregistry)** — a durable factory and trust root. It holds committees (gov members + voting power), an `admin` and an `operator`, gGov delegations, and a `periodId → GGovPeriodSummary` index. It spawns one `GGovPeriod` app per voting period via inner transaction.
- **[`GGovPeriod`](#ggovperiod)** — one app per voting period. It holds that period's topics, vote tallies, vote records, and period/topic body JSON. It inner-calls the registry for operator/admin checks, delegation resolution, voting power, and to mirror its summary back to the registry.

```
                ┌──────────────────────────────────┐
                │           GGovRegistry           │   durable factory · trust root
                │  committees · operator · admin   │
                │  delegations · period summaries  │
                └────────────────┬─────────────────┘
                                 │ createPeriod(): inner-txn create + fund + init
                 ┌───────┬───────┴───────┬───────┐
                 ▼       ▼       ▼       ▼       ▼
                 GGovPeriod apps — one per voting period

  each GGovPeriod app owns its topics · tallies · vote records, reads the
  registry's admin / operator globals directly for auth, and inner-calls the
  registry for getDelegate / getGovVotingPower / updatePeriodSummary
```

> **Note on naming**: the "Committee Oracle" referenced in earlier docs is now folded into the **`GGovRegistry`** contract (see [historical note](#xgov-committee-oracle-historical-name)). The repo's `xgov-delegator` name is a holdover from an earlier `Delegator` contract experiment (since removed); the frac-delegation registry/instance contracts that succeeded it trace their design back to the [`xgov-delegator`](https://github.com/d13co/xgov-delegator) prototype.

# Deployment

`smart_contracts/index.ts` runs every `smart_contracts/*/deploy-config.ts`, with `ggov-registry` always before `frac-delegation` (`DEPLOY_ORDER`) and the rest alphabetically.

```sh
algokit project deploy <network>   # full bundle (runs pnpm run deploy:ci)
algokit project deploy localnet -- ggov-registry  # single contract, by directory name
pnpm run deploy:ci [contract-dir-name]            # same, without algokit (env from .env only)
pnpm run deploy [contract-dir-name]               # watch mode: redeploys on file save (localnet iteration)
```

Environment: `algokit project deploy <network>` loads `.env` then `.env.<network>` on top (see `.env.template`; all real `.env*` files are gitignored). Algod/indexer endpoints default per network. TestNet/MainNet deploys expect `DEPLOYER_MNEMONIC` and `DISPENSER_MNEMONIC`.

## Registry wiring

Each `deploy-config.ts` deploys only its own app. The cross-app links live in `smart_contracts/wire-registries.ts`, which `index.ts` runs once after every deploy config:

| Link                                     | Set to                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `GGovRegistry.xGovRegistryApp`           | `XGOV_REGISTRY_APP_ID` (env only — this repo never deploys an xGov registry) |
| `GGovRegistry.fracRegistryApp`           | the frac delegation registry                                                 |
| `FracDelegationRegistry.gGovRegistryApp` | the gGov registry                                                            |

Each app id is resolved in this order: **deployed by the current run** → `GGOV_REGISTRY_APP_ID` / `FRAC_REGISTRY_APP_ID` → the app of that name created by the same `DEPLOYER`. So a full-bundle deploy couples the registries with no configuration, and a standalone deploy (`deploy:ci ggov-registry`) wires against whatever already exists. The env vars are only needed to point at an app the `DEPLOYER` did not create.

Every link is idempotent (skipped when already set) and never fails the deploy: if the target app can't be read, or its admin isn't the `DEPLOYER`, wiring warns and moves on.

<a id="ggovregistry"></a>

# GGovRegistry

The durable, never-redeployed root of the gGov system. It stores committees and their gov voting power, identity (`admin`/`operator`), gGov delegations, and a per-period summary index. New voting periods are spawned as independent `GGovPeriod` apps via inner transaction from `createPeriod`.

## Design Rationale

The account&lt;-&gt;committee schema was designed to minimize the overhead of storing multiple account-to-committee relationships.

Accounts are assigned an incremental uint32 ID ("AccountID"), which is used in committee membership values along with a uint32 value of the account's voting power. The 32KB box size limitation is overcome by using the [Superbox](https://github.com/tasosbit/puya-ts-superbox) library which abstracts an array of fixed-length values over multiple boxes.

Accounts also store their memberships in committees in a list of 2 uint16 values, committee numeric ID and account ID value offset

### Limits

Max number of committees: 2^16. Committee IDs and account offset hints are stored as uint16 in GGovAccount structs.

Max committee membership count: 2^16. See above.

Max accounts: 2^32. Accounts are assigned uint32 identifiers in order to compress their representations on multiple committees (4 byte ID vs 32 byte address)

Max votes per account: 2^32. Account voting power is stored as a uint32.

Max delegations per delegatee: ~1024. At the moment we store reverse delegation lookups for accounts in a single box.

## State

### Global

- `admin`: Account (default: creator) - admin address, rotatable via `setAdmin`
- `operator`: Account - operator address; manages periods on spawned `GGovPeriod` apps
- `xGovRegistryApp`: Application (key: `xGovRegistryApp`) - xGov registry application ID
- `fracRegistryApp`: Application (key: `fracRegistryApp`) - fractional delegation registry application ID; read by `importFracDelegations` to resolve escrows
- `lastCommitteeId`: uint64 (0) - incrementing committee numeric ID; also the committee superbox prefix counter
- `lastPeriodId`: uint64 (0) - incrementing period ID counter
- `lastAccountId`: uint64 (0) - incrementing account numeric ID counter

### Account boxes (keyPrefix: 'a')

key: address

value: GGovAccount struct

- `accountId`: uint32 - incrementing ID assigned to the account (saves 28 bytes per reference)
- `committeeOffsets`: [committeeNumericId uint16, accountOffset uint16][] - per-committee superbox offset hints, for opcode-cheap voting-power lookups

### Committee Metadata (keyPrefix: 'c')

key: committee_id (byte[32])

value: CommitteeMetadata struct

- `numericId`: uint16 - committee numeric ID (drives the superbox prefix)
- `periodStart`: uint32
- `periodEnd`: uint32 (exclusive)
- `totalMembers`: uint32 - total govs in the committee
- `totalVotes`: uint32 - total votes across the committee
- `xGovRegistryId`: uint64
- `ingestedVotes`: uint32 - running tally of ingested voting power, for verification

### Committee > Gov voting power

Uses [Superbox](https://github.com/tasosbit/puya-ts-superbox)

key: superbox prefix (`'S' + numericId`)

value: Array of tuples [accountId uint32, votes uint32]

### Period Summaries (keyPrefix: 'p')

Per-period summary mirrored from each spawned `GGovPeriod` app.

key: period_id (uint32)

value: GGovPeriodSummary struct

- `appId`: uint64 - spawned `GGovPeriod` app ID
- `votingStart`: uint32
- `votingEnd`: uint32 (exclusive)
- `numTopics`: uint32
- `ready`: boolean - whether the period has been marked ready (voting open, edits locked)

### Delegations (keyPrefix: 'd')

Forward gGov voting delegation.

key: delegator address

value: delegatee address

### Reverse Delegations (keyPrefix: 'D')

Reverse index maintained in lockstep with `delegations`, so the frontend can answer "who delegated to me?" with a single box read keyed by the delegatee.

key: delegatee address

value: delegator addresses (Account[])

### Period Approval Program (key: 'Pap')

GGovPeriod approval-program bytecode, chunk-uploaded by admin and read by `createPeriod` when spawning a new period app. Lets admins ship period approval-program upgrades without redeploying the registry; existing periods are independent apps and are unaffected.

## Methods

### Lifecycle Methods

- `updateApplication()` - App updatable by the admin (bare method; `ensureCallerIsAdmin`)
- `deleteApplication()` - App deletable by the admin (bare method; `ensureCallerIsAdmin`)

### Admin Methods

- `registerCommittee(committeeId, periodStart, periodEnd, totalMembers, totalVotes, xGovRegistryId)` - Register a committee and create its xGov superbox

```
ensure caller is admin
ensure committee not exists
ensure period_end > period_start
ensure total_members > 0 and total_votes > 0
ensure total_members <= 65535 and lastCommitteeId <= 65535
create committee box with numericId = lastCommitteeId
create superbox with prefix 'S' + lastCommitteeId
increment lastCommitteeId
```

- `unregisterCommittee(committeeId)` - Delete committee. Must have no ingested votes
- `ingestGovs(committeeId, govs: [account, votes][])` - Ingest govs into a committee superbox (ascending account-ID order, dedup-enforced; zero-vote govs rejected; verifies total votes on completion)
- `uningestGovs(committeeId, govs: Account[])` - Remove the last N govs from a committee superbox (strictly descending offset order)
- `setXGovRegistryApp(appId: Application)` - Set the xGov Registry Application ID
- `setAdmin(newAdmin: Account)` - Transfer admin (zero address rejected)
- `setOperator(account: Account)` - Set the operator account
- `uploadPeriodApproval(page1: bytes, page2: bytes, page3: bytes)` - Upload/replace the whole GGovPeriod approval bytecode in one call; the pages are concatenated into box `Pap`, and trailing pages may be empty

### Operator & Delegation Methods

- `createPeriod(committeeId, votingStart, votingEnd, mbrPayment: PaymentTxn)` -> [periodId uint32, appId uint64] - Operator-only inner-txn factory: compiles + creates + funds + initialises a `GGovPeriod` app for the committee

```
ensure caller is operator
ensure votingEnd > votingStart
ensure mbrPayment.receiver === registry address
ensure committee exists and fully ingested (ingestedVotes === totalVotes)
ensure period approval bytecode uploaded
increment lastPeriodId
inner-txn: create GGovPeriod app (approval read back from the box in 3 pages, extra program pages sized from the box, schema off the compiled child)
inner-txn: fund new app MBR from mbrPayment
inner-call: GGovPeriod.init(registry, periodId, committeeId, votingStart, votingEnd)
store period summary { appId, votingStart, votingEnd, numTopics: 0, ready: false }
```

- `updatePeriodSummary(periodId, votingStart, votingEnd, numTopics, ready)` - Mirror a period's summary. Gated on `Global.callerApplicationId === storedAppId` — only the registered period app can update its own summary
- `delegate(delegatee: Account)` - Delegate own gGov voting power (self-delegation rejected; delegator must be a known account)
- `undelegate()` - Remove own delegation
- `mirrorXGovDelegation(account: Account)` - Admin-only: mirror a delegation from the xGov registry's box, if present (self-delegation skipped; refuses to overwrite an account's existing gGov delegation)

### Read Methods

- `getDelegation(account)` -> [Account, boolean] - Delegatee and whether a delegation exists
- `getDelegate(account)` -> Account - Delegatee address, or zero address if none (called by period contracts)
- `logDelegators(delegatee)` - Log the addresses that have delegated to `delegatee` (reverse lookup), one per log line
- `logDelegations(accounts[])` - Log each account's delegatee (zero address if none)
- `getPeriodApp(periodId)` -> uint64 - Spawned period app ID (0 if unknown)
- `getPeriodSummary(periodId)` -> GGovPeriodSummary - Period summary (empty if unknown)
- `logPeriodSummaries(periodIds[])` - Batch log period summaries in input order
- `getCommitteeMetadata(committeeId, mustBeComplete: boolean)` -> CommitteeMetadata
- `logCommitteeMetadata(committeeIds[])` - Log committee metadata for multiple committees
- `logCommitteePages(committeeId, logMetadata, startDataPage, dataPageLength)` - Fetch a committee in "one shot" / parallel queries; logs metadata, superbox meta, and data pages
- `getCommitteeSuperboxMeta(committeeId)` -> SuperboxMeta
- `getGovVotingPower(committeeId, account)` -> uint32 - gov voting power; throws if account/committee unknown or not a member
- `tryGetGovVotingPower(committeeId, account)` -> uint32 - Non-throwing variant (returns 0 instead of throwing); used by `GGovPeriod.canVote`
- `getAccount(account)` -> GGovAccount - Account record (accountId 0 if unknown)
- `logAccounts(accounts[])` - Log multiple accounts' records for quick fetching with simulate

<a id="ggovperiod"></a>

# GGovPeriod

One app per voting period, spawned by the registry's `createPeriod`. It owns the period's topics, vote tallies, vote records, and period/topic body JSON. All operator/admin checks, delegation resolution, and voting-power lookups are delegated to the registry via inner call; every edit mirrors the summary back via `registry.updatePeriodSummary`.

A period is **editable** until the operator calls `setReady(true)`. Once ready, edits are blocked and voting is open within `[votingStart, votingEnd)`. `setReady(false)` is only allowed if no votes have been cast.

## State

### Global

- `registryApp`: uint64 (0) - registry app ID; 0 sentinel means uninitialised
- `periodId`: uint64 - this period's ID on the registry
- `votingStart`: uint64 - voting window start (unix seconds, inclusive)
- `votingEnd`: uint64 - voting window end (unix seconds, exclusive)
- `ready`: boolean (false) - ready flag; must be true to accept votes, and blocks edits while set
- `committeeId`: byte[32] - committee this period votes against (lives in the registry)

### Topic Options (key: 'o')

Per-topic option labels. Mutated only while editable. Parallel to topic votes (same length & order).

value: GGovTopicOptions[] - array of `{ options: string[] }`

### Topic Votes (key: 't')

Per-topic vote tallies. Mutated on every `vote()`. Parallel to topic options (same length & order).

value: GGovTopicVotes[] - array of `{ votes: uint32[] }`

### Period Body (key: 'P')

value: bytes - period body JSON (chunk-uploaded)

### Topic Bodies (keyPrefix: 'T')

key: topic_index (uint64)

value: bytes - topic body JSON (chunk-uploaded)

### Vote Records (keyPrefix: 'v')

Per-voter vote record for this period.

key: voter address

value: GGovVoteRecord struct

- `isDelegated`: boolean - whether the record was cast by a delegatee on the voter's behalf
- `topicVotes`: uint32[][] - the voter's per-topic vote allocation (used to subtract old votes when re-voting)

## Methods

### Lifecycle Methods

- `init(registryApp, periodId, committeeId, votingStart, votingEnd)` - Initialise the period. Called once, as an inner ARC-4 call from the registry's `createPeriod` (sender must be the creator/registry app account)
- `updateApplication()` - App updatable by the registry admin (resolved from the registry's `admin` global state; the creator/registry app account is a permanent escape hatch)
- `deleteApplication()` - App deletable by the registry admin (resolved from the registry's `admin` global state; the creator/registry app account is a permanent escape hatch)

### Operator Methods

Operator status is resolved from the registry's `operator` global state (read directly, no inner call). All of these require the period to be editable (`ready === false`).

- `editPeriod(committeeId, votingStart, votingEnd)` - Edit committee + voting window; syncs summary to registry
- `addTopic(options: string[])` -> topicIndex uint64 - Append a topic with zeroed tallies; syncs summary
- `editTopic(topicIndex, options: string[])` - Replace a topic's options (resets its tallies)
- `removeTopic(topicIndex)` - Remove a topic; syncs summary
- `setReady(ready: boolean)` - Set the ready flag; syncs summary. Setting `ready === false` requires all tallies to be zero
- `uploadPeriodBodyPartial(startOffset, data, last)` - Upload/replace a chunk of the period body JSON
- `uploadTopicBodyPartial(topicIndex, startOffset, data, last)` - Upload/replace a chunk of a topic body JSON

### Voting Methods

- `vote(voterAccount, topicVotes: uint64[][])` - Cast (or re-cast) a vote, direct or delegated

```
ensure ready
ensure votingStart <= now < votingEnd
if sender !== voterAccount:
  inner-call registry.getDelegate(voterAccount), ensure it === sender   // delegated vote
inner-call registry.getGovVotingPower(committeeId, voterAccount)        // voting power
ensure topicVotes shape matches topics; each topic's votes sum to votingPower
if a record already exists:
  reject if a delegatee tries to override a direct vote
  subtract the old allocation from the tallies
add the new allocation to the tallies
store vote record { isDelegated, topicVotes }
```

- `canVote(voterAccount, senderAccount)` -> [boolean, uint64] - Whether the account can vote and the resulting voting power; returns `[false, 0]` in any rejection case (mirrors `vote`'s checks, non-throwing)

### Read Methods

- `getPeriod()` -> GGovPeriod - Merged period view: `{ committeeId, votingStart, votingEnd, topics: [{ options, votes }] }`
- `getVotingRecord(account)` -> GGovVoteRecord - The account's vote record (empty if none)

---

<a id="xgov-committee-oracle-historical-name"></a>

# xgov-committee-oracle (historical name)

The committee oracle has been folded into [`GGovRegistry`](#ggovregistry). Its committee storage, account-ID system, and gov voting-power superbox live there now, alongside the operator, delegations, and period factory. This section is kept as a historical reference to the standalone oracle design.

## Global State

- `last_account_id`: uint32 (0) - incrementing account ID counter
- `lastSuperboxPrefix`: uint64 (0) - incrementing superbox prefix for committees
- `xGovRegistryApp`: Application - xGov registry application ID

## Boxes

### Account (keyPrefix: 'A')

key: address

value: uint32 incrementing ID

### Committee (keyPrefix: 'c')

Key: committee_id (byte[32])

Value: CommitteeMetadata struct

- `periodStart`: uint32
- `periodEnd`: uint32 (exclusive)
- `totalMembers`: uint32
- `totalVotes`: uint32
- `xGovRegistryId`: uint64
- `ingestedVotes`: uint32 - keep track of ingested voting power for verification
- `superboxPrefix`: string

### Committee > gov voting power

Uses [Superbox](https://github.com/tasosbit/puya-ts-superbox)

key: superbox_prefix

value: Array of tuples [accountId uint32, votes uint32]

## Methods

### Admin Methods

- `registerCommittee(committeeId, periodStart, periodEnd, totalMembers, totalVotes, xGovRegistryId)` - Register a committee

```
ensure committee not exists
ensure period_end > period_start
create committee box
create superbox with prefix 'S' + lastSuperboxPrefix
increment lastSuperboxPrefix
```

- `unregisterCommittee(committeeId)` - Delete committee. Must not have any ingested votes

```
ensure committee exists
ensure ingested_votes === 0
delete committee box
delete superbox
```

- `ingestGovs(committeeId, govs: [account, votes][])` - Ingest govs into a committee

```
// get committee record for metadata
committee = self.committees[committee_id]
// account/xgov ingest progress uses superbox size
ingested_accounts = count from superbox
// get last ingested ID to ensure ascending ID order, deduplication enforcement
last_ingested_id = ingested_accounts > 0 ? [ingested_accounts - 1].id : 0
// ensure we are not going over by # of accounts
assert(ingested_accounts + govs.length <= committee.total_members)
// buffer to write to superbox once
write_chunk: bytes of shape [id, votes][]
// iterate govs
foreach gov in govs:
  // reject zero-vote govs (no voting power)
  assert votes > 0
  // get or create account id
  account_id = getOrCreateAccountId(account)
  // assert ascending ID ingestion for dedupe/uniqueness enforcement
  assert account_id > last_ingested_id
  // keep track of ingested votes
  committee.ingested_votes += votes
  // assert not going over available votes
  assert committee.ingested_votes <= committee.total_votes
  // increase counter
  last_ingested_id = account_id
  write_chunk += [account_id, votes]
// write to superbox once
sbAppend(superbox_name, write_chunk)
// if finished, ensure total votes match
if ingested_accounts + govs.length === committee.total_members
  ensure committee.ingested_votes === committee.total_votes
```

- `uningestGovs(committeeId, numGovs)` - Delete last N govs from committee superbox
- `setXGovRegistryApp(appId: Application)` - Set the xGov Registry Application ID

### Read Methods

- `getAccountId(account)` -> uint32 - Get account ID if exists, else return 0
- `logAccountIds(accounts[])` - Log multiple accounts' IDs for quick fetching with simulate
- `getCommitteeMetadata(committeeId, mustBeComplete: boolean)` -> CommitteeMetadata - Get committee metadata
- `logCommitteeMetadata(committeeIds[])` - Log committee metadata for multiple committees
- `logCommitteePages(committeeId, logMetadata, startDataPage, dataPageLength)` - Facilitates fetching committee in "one shot" / parallel queries. Logs metadata, superbox meta, and data pages
- `getCommitteeSuperboxMeta(committeeId)` -> SuperboxMeta - Get committee superbox metadata
- `getGovVotingPower(committeeId, account, accountOffsetHint)` -> uint32 - Get gov voting power with required account offset hint (for opcode savings)

```
ensure committee exists
account_id = getAccountIdIfExists(account)
ensure account_id !== 0
gov = get superbox gov at offset account_offset_hint
ensure gov.account_id === account_id
return gov.votes
```
