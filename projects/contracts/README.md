# gGov

General governance voting for Algorand, built around xGov committees and gGov vote delegation.

gGov is two cooperating smart contracts:

- **[`GGovRegistry`](#ggovregistry)** — a durable factory and trust root. It holds committees (xGov members + voting power), an `admin` and an `operator`, gGov delegations, and a `periodId → GGovPeriodSummary` index. It spawns one `GGovPeriod` app per voting period via inner transaction.
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

  each GGovPeriod app owns its topics · tallies · vote records, and inner-calls
  the registry for verifyOperator / verifyAdmin / getDelegate /
  getXGovVotingPower / updatePeriodSummary
```

> **Note on naming**: the "Committee Oracle" referenced in earlier docs is now folded into the **`GGovRegistry`** contract (see [historical note](#xgov-committee-oracle-historical-name)). The original [`Delegator`](#delegator-experiment) contract that gave this repo its `xgov-delegator` name is an earlier experiment and is documented last.

<a id="ggovregistry"></a>
# GGovRegistry

The durable, never-redeployed root of the gGov system. It stores committees and their xGov voting power, identity (`admin`/`operator`), gGov delegations, and a per-period summary index. New voting periods are spawned as independent `GGovPeriod` apps via inner transaction from `createPeriod`.

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
  - `totalMembers`: uint32 - total xGovs in the committee
  - `totalVotes`: uint32 - total votes across the committee
  - `xGovRegistryId`: uint64
  - `ingestedVotes`: uint32 - running tally of ingested voting power, for verification

### Committee > xGov voting power

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
- `ingestXGovs(committeeId, xGovs: [account, votes][])` - Ingest xGovs into a committee superbox (ascending account-ID order, dedup-enforced; verifies total votes on completion)
- `uningestXGovs(committeeId, xGovs: Account[])` - Remove the last N xGovs from a committee superbox (strictly descending offset order)
- `setXGovRegistryApp(appId: Application)` - Set the xGov Registry Application ID
- `setAdmin(newAdmin: Account)` - Transfer admin (zero address rejected)
- `setOperator(account: Account)` - Set the operator account
- `uploadPeriodApprovalPartial(startOffset: uint64, data: bytes, last: boolean)` - Upload/replace a chunk of the GGovPeriod approval bytecode (`startOffset === 0` resets the box)

### Operator & Delegation Methods

- `createPeriod(committeeId, votingStart, votingEnd, mbrPayment: PaymentTxn)` -> [periodId uint32, appId uint64] - Operator-only inner-txn factory: compiles + creates + funds + initialises a `GGovPeriod` app for the committee

```
ensure caller is operator
ensure votingEnd > votingStart
ensure mbrPayment.receiver === registry address
ensure committee exists and fully ingested (ingestedVotes === totalVotes)
ensure period approval bytecode uploaded
increment lastPeriodId
inner-txn: create GGovPeriod app (approval from box, max extra program pages + reserved schema)
inner-txn: fund new app MBR from mbrPayment
inner-call: GGovPeriod.init(registry, periodId, committeeId, votingStart, votingEnd)
store period summary { appId, votingStart, votingEnd, numTopics: 0, ready: false }
```

- `updatePeriodSummary(periodId, votingStart, votingEnd, numTopics, ready)` - Mirror a period's summary. Gated on `Global.callerApplicationId === storedAppId` — only the registered period app can update its own summary
- `delegate(delegatee: Account)` - Delegate own gGov voting power (self-delegation rejected; delegator must be a known account)
- `undelegate()` - Remove own delegation
- `mirrorXGovDelegation(account: Account)` - Mirror a delegation from the xGov registry's box, if present (self-delegation skipped)

### Read Methods

- `verifyAdmin(account)` -> boolean - Whether account is the admin (called by period contracts via inner txn)
- `verifyOperator(account)` -> boolean - Whether account is the operator (called by period contracts via inner txn)
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
- `getXGovVotingPower(committeeId, account)` -> uint32 - xGov voting power; throws if account/committee unknown or not a member
- `tryGetXGovVotingPower(committeeId, account)` -> uint32 - Non-throwing variant (returns 0 instead of throwing); used by `GGovPeriod.canVote`
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

  - `byDelegator`: boolean - whether the record was cast by a delegatee on the voter's behalf
  - `topicVotes`: uint32[][] - the voter's per-topic vote allocation (used to subtract old votes when re-voting)

## Methods

### Lifecycle Methods

- `init(registryApp, periodId, committeeId, votingStart, votingEnd)` - Initialise the period. Called once, as an inner ARC-4 call from the registry's `createPeriod` (sender must be the creator/registry app account)
- `updateApplication()` - App updatable by the registry admin (verified via inner call to `registry.verifyAdmin`)
- `deleteApplication()` - App deletable by the registry admin (verified via inner call to `registry.verifyAdmin`)

### Operator Methods

Operator status is verified via inner call to `registry.verifyOperator`. All of these require the period to be editable (`ready === false`).

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
inner-call registry.getXGovVotingPower(committeeId, voterAccount)        // voting power
ensure topicVotes shape matches topics; each topic's votes sum to votingPower
if a record already exists:
  reject if a delegatee tries to override a direct vote
  subtract the old allocation from the tallies
add the new allocation to the tallies
store vote record { byDelegator, topicVotes }
```

- `canVote(voterAccount, senderAccount)` -> [boolean, uint64] - Whether the account can vote and the resulting voting power; returns `[false, 0]` in any rejection case (mirrors `vote`'s checks, non-throwing)

### Read Methods

- `getPeriod()` -> GGovPeriod - Merged period view: `{ committeeId, votingStart, votingEnd, topics: [{ options, votes }] }`
- `getVotingRecord(account)` -> GGovVoteRecord - The account's vote record (empty if none)

---

<a id="delegator-experiment"></a>
# Delegator (experiment)

> **Experiment.** The `Delegator` contract is the earlier experiment that gave this repo its `xgov-delegator` name. It explores delegating pooled/liquid-staking xGov voting power via an on-chain "algohours" metric. It predates the gGov design above and is not part of the current gGov flow. It is kept here for reference.
>
> The delegator's `setCommitteeOracleApp` / `committeeOracleApp` API names are preserved for backward compatibility, but the app they point to is now the [`GGovRegistry`](#ggovregistry) (the committee oracle was folded into it).

Smart contract to delegate xGov voting power for pooled and liquid staking systems.

- xgov committees
  - needs data to be synced to contract:
    - committee ID
      - read this from proposals to know if delegated account has voting power
    - period start round (inclusive)
    - period end round (exclusive)
    - sync from xgov-committee-oracle
      - do we need to get xgov delegations from registry?

- external voting power
  - xgov votes delegated to this system on xGov registry. Delegators would usually be smart contract account(s) (e.g. reti pool, dualstake token, etc)
  - support multiple accounts. E.g. reti can have up to 4 pools, xALGO/tALGO have multiple participating contract escrows. Etc

- internal voting power
  - voting power split between accounts participating
  - metric: algohours
    - corresponds to 1 hour of 1 algo staked in the system
  - offchain/trusted component to generate algohours per committee period
  - stored per 1M rounds to reduce stored state

## State

### Global

- `lastAccountId`: uint64 (0) - incrementing account ID counter (inherited from `AccountIdContract`)
- `committeeOracleApp`: Application - Committee Oracle Application ID
- `voteSubmitThreshold`: uint64 (10800) - time in seconds before external vote end to submit votes (default: 3 hours)
- `absenteeMode`: string ('strict') - absentee mode: 'strict' or 'scaled'

### Account boxes (keyPrefix: 'a')

key: address

value: uint32 incrementing ID

Assigns uint32 ids to accounts to save 28 bytes per reference (from `AccountIdContract`)

### Algohour Period Totals (keyPrefix: 'H')

Total internal voting power per period fragment (1M rounds)

key: period_start (uint64, aligned to 1M)

value: AlgohourPeriodTotals struct

  - `totalAlgohours`: uint64 - total algohours between [period_start, period_start+1M)
  - `final`: boolean - indicates account algohour records are complete for this period

### Algohour per Account (keyPrefix: 'h')

Account internal voting power per 1M period fragment

key: [period_start (uint64), account_id (uint32)]

value: algohours (uint64)

### Committee Metadata (keyPrefix: 'C')

Synced committee details with own delegated totals

key: committee_id (byte[32])

value: DelegatorCommittee struct

  - `periodStart`: uint32
  - `periodEnd`: uint32
  - `extDelegatedVotes`: uint32 - total voting power delegated by xGov. Can be split across multiple accounts
  - `extDelegatedAccountVotes`: [accountId uint32, votes uint32][] - individual delegated xGov accounts & their voting power

### Proposal Metadata (keyPrefix: 'P')

key: proposal_id (Application)

value: DelegatorProposal struct

  - `status`: string - 'WAIT' | 'VOTE' | 'VOTD' | 'CANC'
  - `committeeId`: byte[32]
  - `extVoteStartTime`: uint32
  - `extVoteEndTime`: uint32
  - `extTotalVotingPower`: uint32 (not dupe - committee member may have been removed for absenteeism)
  - `extAccountsPendingVotes`: [accountId uint32, votes uint32][] - added when synced, removed when vote is cast
  - `extAccountsVoted`: [accountId uint32, votes uint32][] - accounts that have voted
  - `intVoteEndTime`: uint32 - set earlier than external to allow for vote submission before xGov proposal voting ends
  - `intTotalAlgohours`: uint64 - sum of algohour period totals for committee periods
  - `intVotedAlgohours`: uint64
  - `intVotesYesAlgohours`: uint64
  - `intVotesNoAlgohours`: uint64
  - `intVotesAbstainAlgohours`: uint64
  - `intVotesBoycottAlgohours`: uint64

### Vote Receipts (keyPrefix: 'V')

Per-subdelegator vote receipt, ensuring each subdelegator votes once (changing a vote subtracts the old allocation and adds the new).

key: [proposal_id (Application), account_id (uint32)]

value: DelegatorVote struct

  - `yesVotes`: uint64
  - `noVotes`: uint64
  - `abstainVotes`: uint64
  - `boycottVotes`: uint64

## Methods

### Admin Methods

- `setCommitteeOracleApp(appId: Application)` - Set the Committee Oracle Application ID
- `setVoteSubmitThreshold(threshold: uint64)` - Set the vote submit threshold (time in seconds before external vote end)
- `setAbsenteeMode(mode: 'strict' | 'scaled')` - Set the absentee mode
- `addAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: [account, hours][])` - Add account algohours and update total for period
- `removeAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: [account, hours][])` - Remove account algohours and update total for period
- `updateAlgoHourPeriodFinality(periodStart: uint64, totalAlgohours: uint64, final: boolean)` - Update period algohour finality status

### Sync Methods

- `syncCommitteeMetadata(committeeId: byte[32], delegatedAccounts: Account[])` - Sync committee metadata and delegated accounts from CommitteeOracle
- `syncProposalMetadata(proposalId: Application)` -> DelegatorProposal - Sync proposal metadata from xGov registry

### Voting Methods

- `voteInternal(proposalId: Application, voterAccount: Account, vote: DelegatorVote)` - Cast/recast a subdelegator's internal (algohour-weighted) vote on a proposal
- `voteExternal(proposalId: Application, extAccounts: Account[])` - Submit the aggregated external xGov vote to the xGov registry for the given delegated accounts

### Read Methods

- `getAlgoHourPeriodTotals(periodStart: uint64)` - Get total algohours and finality for period
- `getAccountAlgoHours(periodStart: uint64, account: Account)` - Get account algohours for period
- `logCommitteeMetadata(committeeIds: byte[32][])` - Log committee metadata for multiple committees
- `logProposalMetadata(proposalIds: Application[])` - Log proposal metadata for multiple proposals

---

<a id="xgov-committee-oracle-historical-name"></a>
# xgov-committee-oracle (historical name)

The committee oracle has been folded into [`GGovRegistry`](#ggovregistry). Its committee storage, account-ID system, and xGov voting-power superbox live there now, alongside the operator, delegations, and period factory. This section is kept as a historical reference to the standalone oracle design.

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

### Committee > xGov voting power

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

- `ingestXGovs(committeeId, xGovs: [account, votes][])` - Ingest xGovs into a committee

```
// get committee record for metadata
committee = self.committees[committee_id]
// account/xgov ingest progress uses superbox size
ingested_accounts = count from superbox
// get last ingested ID to ensure ascending ID order, deduplication enforcement
last_ingested_id = ingested_accounts > 0 ? [ingested_accounts - 1].id : 0
// ensure we are not going over by # of accounts
ensure(ingested_accounts + xGovs.length <= committee.total_members)
// buffer to write to superbox once
write_chunk: bytes of shape [id, votes][]
// iterate xGovs
foreach xGov in xGovs:
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
if ingested_accounts + xGovs.length === committee.total_members
  ensure committee.ingested_votes === committee.total_votes
```

- `uningestXGovs(committeeId, numXGovs)` - Delete last N xGovs from committee superbox
- `setXGovRegistryApp(appId: Application)` - Set the xGov Registry Application ID

### Read Methods

- `getAccountId(account)` -> uint32 - Get account ID if exists, else return 0
- `logAccountIds(accounts[])` - Log multiple accounts' IDs for quick fetching with simulate
- `getCommitteeMetadata(committeeId, mustBeComplete: boolean)` -> CommitteeMetadata - Get committee metadata
- `logCommitteeMetadata(committeeIds[])` - Log committee metadata for multiple committees
- `logCommitteePages(committeeId, logMetadata, startDataPage, dataPageLength)` - Facilitates fetching committee in "one shot" / parallel queries. Logs metadata, superbox meta, and data pages
- `getCommitteeSuperboxMeta(committeeId)` -> SuperboxMeta - Get committee superbox metadata
- `getXGovVotingPower(committeeId, account, accountOffsetHint)` -> uint32 - Get xGov voting power with required account offset hint (for opcode savings)

```
ensure committee exists
account_id = getAccountIdIfExists(account)
ensure account_id !== 0
xGov = get superbox xGov at offset account_offset_hint
ensure xGov.account_id === account_id
return xGov.votes
```
