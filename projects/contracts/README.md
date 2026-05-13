# xgov-delegator and [GGovRegistry](#ggov-registry)

> **Note on naming**: the "Committee Oracle" referenced throughout this document is now the **`GGovRegistry`** contract. The registry is a durable factory that also holds an operator, gGov delegations, and a `periodId → GGovPeriodSummary` index. It spawns one `GGovPeriod` app per voting period via inner-txn. The delegator's `setCommitteeOracleApp` / `committeeOracleApp` API names are preserved for backward compatibility but the app they point to is the registry.

# xgov-delegator

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

- `last_account_id`: uint32 (0) - incrementing account ID counter
- `committeeOracleApp`: Application - Committee Oracle Application ID
- `voteSubmitThreshold`: uint64 (10800) - time in seconds before external vote end to submit votes (default: 3 hours)
- `absenteeMode`: string ('strict') - absentee mode: 'strict' or 'scaled'

### Account boxes (keyPrefix: 'A')

key: address

value: uint32 incrementing ID

Assigns uint32 ids to accounts to save 28 bytes per reference

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
- `status`: string - 'WAIT' | 'VOTD' | 'CANC'
- `committeeId`: byte[32]
- `extVoteEndTime`: uint32
- `extTotalVotingPower`: uint32 (not dupe - committee member may have been removed for absenteeism)
- `extAccountsPendingVotes`: [accountId uint32, votes uint32][] - added when synced, removed when vote is cast
- `extAccountsVoted`: [accountId uint32, votes uint32][] - accounts that have voted
- `intVoteEndTime`: uint64 - set earlier than external to allow for vote submission before xGov proposal voting ends
- `intTotalAlgohours`: uint64 - sum of algohour period totals for committee periods
- `intVotedAlgohours`: uint64
- `intVotesYesAlgohours`: uint64
- `intVotesNoAlgohours`: uint64
- `intVotesBoycottAlgohours`: uint64

### Vote Receipts (not yet implemented)

key: [account id][proposal_id]

value: empty # if no changing vote allowed

value: [votes_yes,votes_no] # if changing vote is allowed

receipt to ensure each subdelegator votes once

changing votes could be allowed, subtract previous votes_yes / votes_no and add new ones

## Methods

### Admin Methods

- `setCommitteeOracleApp(appId: Application)` - Set the Committee Oracle Application ID
- `setVoteSubmitThreshold(threshold: uint64)` - Set the vote submit threshold (time in seconds before external vote end)
- `setAbsenteeMode(mode: 'strict' | 'scaled')` - Set the absentee mode
- `addAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: [account, hours][])` - Add account algohours and update total for period
- `removeAccountAlgoHours(periodStart: uint64, accountAlgohourInputs: [account, hours][])` - Remove account algohours and update total for period
- `updateAlgoHourPeriodFinality(periodStart: uint64, totalAlgohours: uint64, final: boolean)` - Update period algohour finality status

### Sync Methods

- `syncCommitteeMetadata(committeeId: byte[32], delegatedAccounts: [account, offsetHint][])` - Sync committee metadata and delegated accounts from CommitteeOracle
- `syncProposalMetadata(proposalId: Application)` - Sync proposal metadata from xGov registry

### Read Methods

- `getAlgoHourPeriodTotals(periodStart: uint64)` - Get total algohours and finality for period
- `getAccountAlgoHours(periodStart: uint64, account: Account)` - Get account algohours for period

<a id="ggov-registry"></a>
# GGovRegistry (formerly xgov-committee-oracle)

The committee oracle has been folded into `GGovRegistry`, which adds:

- `operator` global state and `setOperator` / `verifyOperator` / `getOperator`
- gGov delegation BoxMap (`d` prefix) + `delegate` / `undelegate` / `getDelegation` / `getDelegate` / `logDelegations` / `mirrorXGovDelegation`
- `periods` BoxMap (`p` prefix) keyed by `Uint32` periodId, storing `{ appId, votingStart, votingEnd, numTopics }`
- `createPeriod(committeeId, votingStart, votingEnd, mbrPayment)` — operator-only inner-txn factory that compiles + creates + funds + initialises a `GGovPeriod` app
- `updatePeriodSummary(periodId, votingStart, votingEnd, numTopics)` — gated on `Global.callerApplicationId === storedAppId`; only the registered period app can update its summary
- `getPeriodApp(periodId)`, `getPeriodSummary(periodId)`, `logPeriodSummaries(periodIds[])`
- `tryGetXGovVotingPower(committeeId, account)` — non-throwing variant for `canVote`

Period-level state (topics, vote records, period/topic bodies) lives on the spawned `GGovPeriod` app rather than the registry. The period contract inner-calls the registry for `verifyOperator`, `getDelegate`, `getXGovVotingPower`, and `updatePeriodSummary`.

---

# xgov-committee-oracle (historical name)

Store basic committee info and xgov voting power on chain

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
