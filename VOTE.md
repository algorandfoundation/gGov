# `vote` — internal AQ voting with escrow re-cast into gGov

Lets AlgoQuarter holders vote on a synced gGov period through a `FracDelegationInstance`. Votes are
tallied internally in AQ, mapped pro-rata onto the committee's total escrow gGov power, spread across
the instance's escrows, and cast externally into the gGov period contract via delegated inner calls —
all inside the one `vote()` app call. First consumer of the scaffolding `syncPeriod` zero-fills:
`periodVoteCache.internal` / `.ggovTotals` and `periodEscrowVotes`.

## Decisions locked in

- **Denominator = `committeeAq.totalAq`.** Unvoted AQ implicitly counts as abstain (the last
  option). The denominator never moves, so a vote only re-maps options it touched — minimal escrow
  re-cast churn. A voter's influence is their AQ share of the _whole committee_, not of turnout.
- **Exact sum rule: `Σ topicVotes[t] === userAQ` for every topic** (mirrors gGov's
  `errGGovVotePowerMismatch` rule). Users abstain explicitly via the last option.
- **`votingRecords` MBR comes from the instance balance** — operator pre-funds, sized by
  `committeeAq.numAccounts` (≈0.15 ALGO per voter at ~22-topic shape, ≈0.38 worst case). Matches
  gGovPeriod, whose `vote()` creates `voteRecords` boxes with no MBR payment.
- **Built on `feat/frac-aq-uningest`** — `vote()` needs `accountAq`/`committeeAq`, which aren't on
  `develop`.

## Corrections to the original design notes

1. **No rounding in the escrow spread.** The greedy fill (options consume escrow capacity in order)
   involves no division: per topic `Σ gGovVotes === Σ escrow powers` by construction of the mapping
   stage, so the packing is exact. The "sum + round*down issue in last escrow" doesn't exist —
   rounding lives only in the internal→gGov mapping. Greedy fill is also \_required* shape: it makes
   every escrow row sum to that escrow's full power, which gGov `vote()` demands per topic.
2. **"Last option is abstain" is a convention, not a gGov feature.** Nothing on-chain marks an
   option as abstain; the mapping remainder lands on whatever option is last. Operational invariant:
   every topic of a frac-voted period MUST end with an Abstain option.
3. **The notes had no sum rule** — without `Σ === userAQ` the invariant
   `Σ internal[t] ≤ totalAq` (which keeps the last-option remainder non-negative) breaks.
4. **First vote casts everything.** gGov demands full power per topic, so the first internal vote —
   even 1 AQ — triggers external votes from ALL escrows on ALL topics (mostly onto abstain). There is
   no partial external presence; provision every vote for the worst case. Side effect (good): nonzero
   gGov tallies permanently block `setReady(false)`/`editPeriod` on the period.
5. **Snapshot staleness:** gGov allows un-ready + `editPeriod` (times _and_ committeeId) while its
   tallies are zero, i.e. any time before our first cast. `vote()` therefore re-reads `ready`,
   `votingStart`, `votingEnd`, `committeeId` live off the period app's globals
   (`op.AppGlobal.getEx*` — no inner call, the app ref is needed anyway) instead of trusting the
   `FracInstancePeriod` snapshot, and asserts the live committeeId still matches it.
6. **Escrow prerequisites (ops):** each escrow must be a registered gGov account and have
   `set_voting_account(escrow → instance app address)` in the gGov registry. An escrow that ever
   votes directly creates an `isDelegated=false` record that `errGGovCannotOverride` makes permanent —
   it bricks the instance for that period. Escrows must never self-vote.
7. **Mid-period `syncCommittee` hazard:** `registerEscrow` + re-sync can grow `escrowsVotes` after
   `syncPeriod` sized the `periodEscrowVotes` boxes. `vote()` uses exactly the first
   `period.numEscrows` entries and computes the gGov total `T` as _their_ sum — never
   `committee.totalVotes`, which may include later escrows.

## Signature

```
vote(voterAccount: Account, periodId: Uint32, topicVotes: Uint32[][]): void   // the AQ holder, or its delegatee
canVote(voterAccount: Account, senderAccount: Account, periodId: Uint32): [boolean, uint64]  // readonly mirror
```

`topicVotes` is `[topic][option]` absolute AQ counts, parallel to the period's topics/options, each
topic summing to the voter's full `userAQ`.

> **v1 → v2.** v1 shipped as `vote(periodId, topicVotes)` with the voter hardwired to `Txn.sender`
> and no frac-level delegation. User delegation added `voterAccount` (a breaking selector change,
> mirroring `GGovPeriod.vote`) plus `isDelegated` on the record — see § User delegation.

## Flow

1. `periods(periodId)` must exist (`errGGovPeriodNotExists`).
2. Live period-app globals: `ready > 0` (`errGGovNotReady`);
   `votingStart ≤ now < votingEnd` (`errGGovVotingNotStarted` / `errGGovVotingEnded`, end
   exclusive like gGov); live `committeeId === period.committeeId` (`errPeriodAppMismatch`).
3. `committeeAq(period.committeeNumId)` exists and `ingestedAq === totalAq`
   (`errAqNotStarted` / `errAqIncomplete` — the `FracCommitteeAq` docstring already defines
   "votable" as complete).
4. Outer length: `topicVotes.length === cache.internal.length` (`errGGovVoteMismatch`).
5. Delegation: if `Txn.sender !== voterAccount`, inner-call the **gGov registry**'s
   `getDelegate(voterAccount)` and require it to equal `Txn.sender` (`errGGovNoDelegation`), plus
   `Txn.accounts(1) === voterAccount` (`errGGovDelegationNoAcctRef`) so the delegation is visible to
   indexers. Sets `isDelegated`.
6. Resolve voter: inner-call frac registry `getAccount(voterAccount)` (readonly; **inline the
   `compileArc4` at the call site** — see cyclical-import trap in `UNINGEST.md`); reject
   `accountId === 0` (`errAccountNotExists`). `userAq = accountAq([accountId, committeeNumId])`,
   must exist (`errAccountAqNotExists`).
7. Re-vote: if `votingRecords([periodId, accountId])` exists, reject when `isDelegated` and the
   stored record has `isDelegated === false` (`errGGovCannotOverride` — checked before any mutation),
   then subtract its stored `topicVotes` from `cache.internal`.
8. Tally loop (one pass, like gGov `vote()`): per topic assert inner length (`errGGovVoteMismatch`)
   and `Σ === userAq` (`errGGovVotePowerMismatch`), add into `cache.internal`.
9. Map internal → gGov: `powers = committees(period.committeeId).escrowsVotes[0..numEscrows)`,
   `T = Σ powers`. Per topic: options `0..n-2` get `floor(internal[o] · T / totalAq)` (u32×u32
   product fits u64); the last option gets `T − Σ others` — explicit abstain AQ + unvoted AQ +
   rounding dust.
10. If `gGovVotes !== cache.ggovTotals`: greedy-spread per topic (walk options, consume escrow
    capacity in order, capacities reset each topic). For each escrow with power > 0 whose spread row
    differs from `periodEscrowVotes([periodId, i]).votes`: inner appl
    `GGovPeriodContract.vote(escrow, row)` with `accounts: [escrow]` (lands as the callee's
    `Txn.accounts(1)`); write the escrow box. Escrow addresses read per-index via
    `op.Box.extract('escrows', 2 + 32·i, 32)` — avoids the 4096-byte whole-box decode cap (~127
    entries). Then `cache.ggovTotals = gGovVotes`.
11. Write `votingRecords([periodId, accountId]) = { isDelegated, topicVotes }`, write `cache`, emit
    `FracVoteCast { voter, sender, accountId, userAq, updateVote, topicVotes }` (head 81 B, matching
    gGov's, and gGov `setReady` already caps the votes payload at 943 B → always ≤ 1024).

## User delegation

The gGov registry is the single source of truth for _both_ delegations in this system: escrow →
instance app address (what lets the instance cast externally) and frac user → user (what lets a
delegatee cast an AQ holder's internal vote). Nothing delegation-shaped is stored in frac.

The rules are a direct port of `GGovPeriod.vote`, so one `set_voting_account` covers a user's gGov
period vote and their frac vote identically: `getDelegate` must name the sender, the delegator must
sit at `Txn.accounts(1)`, and a record written directly by the owner (`isDelegated === false`) can
never be overwritten by a delegatee — while the owner may always overwrite a delegated record, which
flips the flag back and locks the delegatee out for the rest of the period.

For frac users this needed one change on the gGov side: `set_voting_account` previously required an
`a<addr>` box on the gGov registry, which a frac-only AQ holder never has. It now accepts a delegator
known to _either_ registry — gGov box first, then a readonly `FracDelegationRegistry.getAccount`
fallback when `fracRegistryApp` is configured.

`canVote(voterAccount, senderAccount, periodId)` is the non-throwing mirror (`[eligible, userAq]`),
including the override guard, matching `GGovPeriod.canVote`. It does not check the `Txn.accounts(1)`
reference, which is a property of the submitted group rather than of eligibility.

## Worked examples

**Mapping** (totalAq 1000, T = 50, one topic, abstain last): internal tally `[300, 100, 50]`
(450 AQ cast) → `[floor(300·50/1000), floor(100·50/1000), rest]` = `[15, 5, 30]` — abstain gets the
2.5 explicit AQ-share, the 550 unvoted AQ, and the rounding dust.

**Spread** (powers 15/15/20, T = 50, topic gGovVotes `[25, 15, 10]`):

| escrow (power) | rows          |
| -------------- | ------------- |
| 1 (15)         | `[15, 0, 0]`  |
| 2 (15)         | `[10, 5, 0]`  |
| 3 (20)         | `[0, 10, 10]` |

Each row sums to the escrow's full power, as gGov requires.

## Errors

| Code                                       | Meaning                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `ERR:GP_NX` (`errGGovPeriodNotExists`)     | period not synced on this instance                                |
| `ERR:GP_NR` / `ERR:GP_NS` / `ERR:GP_EN`    | not ready / voting not started / voting ended (live-read)         |
| `ERR:FP_MM` (`errPeriodAppMismatch`)       | period app's live committeeId no longer matches the synced record |
| `ERR:FA_NS` / `ERR:FA_NC`                  | no AQ ledger / ingest incomplete                                  |
| `ERR:A_NX` (`errAccountNotExists`)         | voter unknown to the frac registry                                |
| `ERR:FA_NX` (`errAccountAqNotExists`)      | voter has no AQ in this committee                                 |
| `ERR:GV_MM` (`errGGovVoteMismatch`)        | topic/option length mismatch                                      |
| `ERR:GV_VP` (`errGGovVotePowerMismatch`)   | a topic's votes don't sum to userAQ                               |
| `ERR:GD_NX` (`errGGovNoDelegation`)        | sender is not the voter's delegatee on the gGov registry          |
| `ERR:GD_NR` (`errGGovDelegationNoAcctRef`) | delegated vote without the voter at `Txn.accounts(1)`             |
| `ERR:GV_OD` (`errGGovCannotOverride`)      | delegatee tried to overwrite a vote the owner cast directly       |

Plus anything the inner gGov `vote()` raises — the same `ERR:GD_NX` (an escrow that never delegated
to the instance) and `ERR:GV_OD` (an escrow that self-voted) codes, from the escrow leg rather than
the user leg. Those fail the whole group; nothing is partially written.

## Cost & sizing

- **Inner txns:** 1 (`getAccount`) + 1 when delegated (the gGov registry's `getDelegate`) + 3 per
  re-cast escrow (`vote` + its own `getDelegate` + `getGovVotingPower`). Pool is 16 per top-level
  appl txn → up to 5 escrows in a bare call; beyond that the SDK pads the group with extra app calls
  (each adds 16 to the pool and 700 opcode budget).
- **Fees:** worst case is provisioned on every vote: `extraFee = (1 + delegated + 3·numEscrows) ×
1000` µALGO (any mapping change can shift greedy boundaries for all escrows, and a no-op re-vote
  still pays — extraFee is spent, not refunded).
- **Reference slots (measured):** `5 × numEscrows + 20`, plus 2 when delegated (the voter's account
  ref and the gGov registry's `d<voter>` box) — per escrow: its _account_ ref (the inner vote()
  carries it in its foreign-accounts array, so it must be available to the group), this
  instance's `periodEscrowVotes` box, the period's `v` record, and the gGov registry's
  `delegations` + `accounts` boxes; fixed: 3 app refs + the instance's 7 boxes + frac registry
  `accounts` + period `t` + gGov committee metadata/superbox. 4-per-escrow sizing fails at 8
  escrows ("No more transactions below reference limit"); 5 passes. The SDK pads
  `increaseBudget` no-ops to carry the slots; population fills them.
- **Overflow-safe:** `internal[o] ≤ totalAq < 2³²`, `T < 2³²` → product `< 2⁶⁴`. Remainder
  non-negative because `Σ internal[t] ≤ totalAq` (exact sum rule + ingest cap).

## New state / types

| Item               | Definition                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `votingRecords`    | `BoxMap<[Uint32, Uint32], FracVotingRecord>({ keyPrefix: 'r' })`, key `[periodId, accountId]` |
| `FracVotingRecord` | `{ isDelegated: boolean, topicVotes: Uint32[][] }` (`base/types.algo.ts`)                     |
| `FracVoteCast`     | ARC-28 event `{ voter, sender, accountId, userAq, updateVote, topicVotes }`                   |

## SDK

`FracDelegationSDK` (`frac-delegation-sdk/src/instance/sdk.ts`):
`vote({ instanceNumId, periodId, topicVotes, voterAccount? })` — like every instance-side method on
the combined SDK it is keyed by `instanceNumId` (PR #78 restructure); sets worst-case `extraFee`,
pads the group past 5 escrows, populates resources. No pre-resolution needed; address→ID is on-chain.
`voterAccount` defaults to the SDK's `writerAccount` (self-vote); pass a delegator to cast on their
behalf and the SDK adds the required `accountReferences: [voterAccount]` and the extra inner-call
fee. Readers: `getVotingRecord(instanceNumId, periodId, accountId)` and
`canVote(instanceNumId, periodId, voterAccount, senderAccount?)`.

The delegation itself is set on the gGov side: `GGovRegistrySDK.setVotingAccount({ votingAddress })`.
The frac-registry fallback costs the contract an inner call, so a frac-only delegator must pass
`fractionalOnly: true` for the fee; gGov delegators (the common case) pay nothing extra.

## Unblocked follow-ups (not in this change)

`uningestAq` and `deleteApplication` must gain "refuse while a period has live votes" guards once
this lands — their existing TODO/doc comments reference exactly this (`UNINGEST.md` §Future).
Likewise, don't uningest gGov govs or re-sync committee power mid-period: live gGov power must keep
matching the frac committee snapshot or external casts fail their sum==power check.

## Tests

`fracDelegationInstance` e2e spec (pattern: existing frac e2e + `ggovPeriod.e2e.spec.ts`):

- First vote: full mapping, all escrows cast, on-chain gGov tallies match; the 15/15/20 × `[25,15,10]`
  spread example as a fixture; rounding remainder lands on the last option.
- Re-vote subtract/add; identical re-vote issues no escrow inner casts; multi-voter convergence
  (`Σ cache.internal[t] ≤ totalAq`, `Σ ggovTotals[t] === T` after first cast).
- Rejections: every error in the table, plus escrow-without-delegation and escrow-self-voted
  (`ERR:GV_OD`) through the inner call.
- User delegation (`describe('user delegation')`): a delegatee casting the owner's weight (record
  flagged `isDelegated`, 5 inner txns, the delegatee gains no frac account of its own); the override
  guard in both directions; a non-delegate sender (`ERR:GD_NX`); a delegated call without the account
  reference, driven through a raw `FracDelegationInstanceClient` (`ERR:GD_NR`); the registry-side
  readers carrying the flag through; and `canVote` agreeing with `vote` at every gate.
- gGov side (`ggovRegistry.delegation.e2e.spec.ts`): a frac-only account may set/clear a voting
  account, an account in neither registry still cannot, the auth rule is unchanged, and with no
  `fracRegistryApp` configured the old gGov-only rule still applies.

## Files

| File                                                       | Change                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `frac-delegation/fracDelegationInstance.algo.ts`           | `vote()` + `votingRecords` box; later: `voterAccount` + delegation gate + override guard + `canVote()`                                         |
| `frac-delegation/fracDelegationRegistry.algo.ts`           | (delegation) `isDelegated` passed through the two `FracAccountVotingRecord` re-taggers                                                         |
| `ggov-registry/ggovRegistry.algo.ts`                       | (delegation) `ensureDelegatorRegistered` — gGov account OR frac account — used by `set_voting_account`                                         |
| `base/types.algo.ts`                                       | `FracVotingRecord`, `FracVoteCast`; later: `isDelegated`, `sender`, `FracAccountVotingRecord.isDelegated`                                      |
| `base/errors.algo.ts`                                      | (no new codes — all reused)                                                                                                                    |
| `frac-delegation-sdk/src/instance/sdk.ts`                  | `makeVoteTxns` / `vote` (incl. `voterAccount` + account reference)                                                                             |
| `frac-delegation-sdk/src/instance/sdkReader.ts`            | `getVotingRecord`, `canVote`                                                                                                                   |
| `ggov-sdk/src/registry/sdk.ts`                             | `setVotingAccount` `fractionalOnly` — opt-in extraFee for the frac fallback                                                                    |
| `frac-delegation/fracDelegationInstance.vote.e2e.spec.ts`  | new spec                                                                                                                                       |
| `frac-delegation/fracDelegationInstance.vote.algo.spec.ts` | unit spec: the one pre-inner-call gate runnable on testing-lib 1.1.0, plus the unit plan (seeding recipe, worked scenarios) as it.todo entries |
| `frac-delegation-sdk/src/registry/sdk.ts`                  | nonced default note on `uploadInstanceApprovalProgram` (fallout, below)                                                                        |
| `frac-delegation/fracDelegationRegistry.admin.e2e.spec.ts` | `initialFundingAlgos` 2 → 3 (fallout, below)                                                                                                   |

## Fallout of the bigger program

`vote()` grew the instance approval program ~50%, which broke two existing registry tests:

- The registry's `Iap` bytecode box MBR rose past the 2 ALGO one `createRegistry` test funded
  exactly — bumped to 3.
- Re-uploading identical bytecode (fixture upload + test re-upload) produced byte-identical chunk
  txns the node rejects as already-in-ledger; `uploadInstanceApprovalProgram` now defaults its note
  to a nonce, the same defence the instance SDK's padding txns already use.
