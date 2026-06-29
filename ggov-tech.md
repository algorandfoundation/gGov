# gGov

See product outline + reasoning in ggov.md

We are replacing this:

API Docs: https://governance.algorand.foundation/api/documentation/

Period data: https://governance.algorand.foundation/api/periods/governance-period-15/

Topic data: https://governance.algorand.foundation/api/voting-sessions/period-15-voting-session-1/

## Architecture

Two contracts:

- **`GGovRegistry`** (durable factory): committees + xGov power + operator + gGov delegations + periods index. The registry holds the `periodId → GGovPeriodSummary` box.
- **`GGovPeriod`** (one app per voting period): topics + tally + vote records + period/topic bodies. Spawned by `registry.createPeriod` via inner-txn.

Cross-contract flow:

```
operator → registry.createPeriod() → itxn creates GGovPeriod app, inner-pays MBR, inner-calls period.init()
operator → period.editPeriod/addTopic() → inner-calls registry.updatePeriodSummary() to keep summary in sync
voter   → period.vote()              → inner-calls registry.getDelegate() + registry.getGovVotingPower()
```

The registry's `updatePeriodSummary` enforces `Global.callerApplicationId === storedAppId` for the given periodId, so only the registered period app can mutate its summary.

## Roles

admin role: upgrade registry, set xGov registry app ID, set operator

operator: CRUD governance periods (create periods, add/edit topics, edit voting windows)

## Types

Box:

```
PeriodSmall {
  id

  committeeId

  votingStart
  votingEnd

  topic: TopicSmall[]
}
```

inlined:

```
TopicSmall {
  id
  options: [Yes, No, Abstain]
  votes: [2,3,0]
}
```

Box:

```
AccountVotingRecord {
  byDelegator: bool
  topicVotes: votes[][] # e.g. [[topic 1 option 1, topic 1 option 2, topic 1 option 3],[topic 2 option 1, topic 2 option 2, topic 2 option 3]]
}
```

Following are JSON in raw boxes:

```
PeriodBig {
  id
  title
  slug
  shortDescription
  bodyHTML
}
```

```
TopicBig {
  id
  title
  bodyHTML
}
```

## Registry global state

- `operator` (account) — set by admin
- `lastPeriodId` (uint64) — auto-increment for `createPeriod`
- `lastCommitteeId` (uint64) — auto-increment for committee numeric ID
- `xGovRegistryApp` (Application) — pointer to xGov registry

## Registry boxes

- `c<committeeId>` — `CommitteeMetadata`
- `a<address>` — `GGovAccount` (the gGov-side accountId + committee offsets)
- `p<periodId(uint32)>` — `GGovPeriodSummary { appId, votingStart, votingEnd, numTopics }`
- `d<address>` — delegatee address (delegations)
- `S<numericId>...` — Superbox storage for committee govs

## Period global state (per app)

- `oracleApp` (uint64) — registry app ID, set by `init`
- `periodId` (uint64) — this period's ID
- `committeeId` (32 bytes), `votingStart` (uint64), `votingEnd` (uint64)

## Period boxes

- `t` — topics array (`GGovTopic[]` with inlined vote tallies)
- `P` — period body JSON (single box)
- `T<topicIndex(uint32)>` — topic body JSON
- `v<address>` — `GGovVoteRecord { byDelegator, topicVotes[][] }`

## Methods

### `vote(periodId, voterAccountWithOracleOffset, topicVotes[][])`

- Check voterAccount has voting power
  - If voterAccount != sender, check sender has delegation permission

- Check outer topicVotes length - we are accepting votes for all topics

- Foreach inner vote:
  - Check inner vote length == topic.options.length
  - Check sum (inner votes) === account voting power
  - If existing vote:
    - If voterAccount != sender AND previous vote was not delegated, fail
    - Subtract existing vote totals from topic
    - Add new vote totals to topic
    - Update votingRecord

### `can_vote(periodId, voterAccountWithOracleOffset): [bool, votes]`

return:

- if sender can vote for voterAccount
- total votes for voterAccount

### `addPeriod`

### `editPeriod`

### `uploadPeriodBodyPartial(periodId, startOffset, data, last: boolean)`

trims if needed if is_last

### `addTopic(title, bodyHTML, options): uint64 topicId`

### `editTopic`

### `uploadTopicBodyPartial(topicId, startOffset, data, last: boolean)`
