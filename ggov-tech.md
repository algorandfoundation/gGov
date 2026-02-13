# gGov

See product outline + reasoning in ggov.md

We are replacing this:

API Docs: https://governance.algorand.foundation/api/documentation/

Period data: https://governance.algorand.foundation/api/periods/governance-period-15/

Topic data: https://governance.algorand.foundation/api/voting-sessions/period-15-voting-session-1/

## Contract

Single contract for multiple committees / voting periods

Extends Oracle

## Roles

admin role: upgrade contract, update committee oracle app ID

operator: CRUD governance period measures

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

## Global State

- lastPeriodId
  - for auto increment
- lastTopicId
  - for auto increment

## Boxes

- Periods
- PeriodsBig
- TopicsBig
- Votes
- Delegations

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



