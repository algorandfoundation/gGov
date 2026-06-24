# gGov Project Proposal

## Smart contract based General Governance platform

I propose we migrate general governance to a smart-contract based system utilizing staked ALGO as the voting power primitive.

Value Proposition:

- Significantly reduce governance operational complexity
- Removes AF trust requirement (closed backend vs open contracts)
- Further Incentivize ALGO Staking
- Relevant to future governance without AF involvement (2030+)

## Operational Complexity

Previous Governance is a legacy system of significant complexity, which has been handed over a number of times. Of the entire Core Engineering team, only Michael Feher has any kind of familiarity with it.

Removing the requirement to “block watch” would reduce complexity by an order of magnitude.

Being a closed system, governance also required running an API server publishing internal data for consumption via the website or third parties.

The “API Server” in this new system would be a combination of a published SDK and an Algorand node serving the data.

Compared to legacy governance, gGov would be smaller, simpler and cheaper to run.

## Voting Power

Align general governance with ALGO staking, as opposed to ALGO holding.

As in xGov, voting power would be granted to accounts that have produced blocks over a period of e.g. 3 million blocks.

Unlike xGov, no explicit opt-in is required \- any block producers would be eligible to vote

## Voting Power Delegation

The new system should maintain ABI compatibility with xGov voting address delegation.

This means that any smart contracts that can delegate their voting rights on the xGov registry, will also be able to do so on the gGov registry.

It would also be possible to mirror existing xGov delegations to gGov, if this is desireable.

## Voting Mechanics

The voting mechanics of classic governance can be fully recreated in gGov. An arbitrary number of measures can be added with Yes / No / Abstain options.

gGov would allow voters to update their votes within the voting timeframe.

## Core Effort Estimate

gGov would be significantly less complex than xGov, as there are no funds involved.

An end-to-end proof of concept including contracts, SDK and frontend should take about 2 sprints.

## Bonus: Voting Delegation for Pooled Staking

One disadvantage of implementing a new system is that any ecosystem platforms that had already integrated classic governance voting (e.g. Folks Finance gALGO) would not be compatible with the new system.

There are a number of popular pooled staking solutions: Reti, Folks xALGO, Tinyman tALGO, etc.

As a stretch goal of gGov, we can build a system that can delegate user votes for these pooling systems.

Some work towards this has been started as a [personal project](https://github.com/d13co/xgov-delegator). The core idea is to calculate a pooling system’s internal voting power for participating accounts based on “time spent staking”, and create proxy contracts for each system that translate the internal voting power to the external gGov / xGov voting power.
