# gGov Contract Architecture

Governance voting on Algorand, built as a **registry-as-factory**: one durable registry app is
the trust root (committees, roles, delegations, period index); each voting period is a separate
app the registry spawns via inner transaction. Source: `projects/contracts/smart_contracts/`.

A separate **fractional delegation** subsystem (`frac-delegation/`) is designed to operate on top of
this one to allow LST and staking pools protocols to split gGov voting power among their users. It interacts
with gGov only through delegation and readonly reads — find its own architecture doc at `FRAC_ARCHITECTURE.md`.
This registry holds _all_ of that subsystem's delegations too: both escrow → instance and frac user →
user (see § Delegation).

## Contracts

| Contract              | File                                        | Role                                                                                                                                                                                 |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GGovRegistry`        | `ggov-registry/ggovRegistry.algo.ts`        | Durable factory + oracle: committees, voting power, operator identity, delegations, period index, period bytecode, period summaries. Extends `GGovRegistryAccount` → `BaseContract`. |
| `GGovRegistryAccount` | `ggov-registry/ggovRegistryAccount.algo.ts` | Assigns uint32 account IDs to addresses and tracks per-committee superbox offsets (28 bytes/ref saved).                                                                              |
| `GGovPeriod`          | `ggov-period/ggovPeriod.algo.ts`            | One app per voting period: topics, tallies, per-voter records, period/topic body JSON. Extends `BaseContract`.                                                                       |
| `BaseContract`        | `base/base.algo.ts`                         | Abstract base: `increaseBudget()` (opcode budget via no-op inner app calls), default admin check.                                                                                    |

Committee membership is stored in `@d13co/superbox` superboxes (`S<numericId>`), letting a
committee hold far more govs than a single 32 KB box.

## Roles & RBAC

The gGov system defines two privileged roles, **admin** and **operator**. The split separates day-to-day content authoring from root-level control.

The **operator** is the Governance team's working role: it drives period and topic setup from the
frontend — creating periods, adding/editing topics, uploading bodies, and marking a period ready —
but it can never move ALGO, change roles, alter committee membership, or upgrade contract code.

The **admin** is the root authority for everything else: committee registration and gov ingestion,
appointing the operator, delegation mirroring, ALGO withdrawal, and updating/deleting app code. This
keeps the operator's blast radius confined to voting content while custody and upgrade authority stay
with the admin.

| Role                  | Source of truth                                                                                             | How it's checked                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Admin**             | Registry `admin` global (defaults to `Global.creatorAddress`, rotatable via `setAdmin`, zero-addr rejected) | Registry: `Txn.sender === admin`. Period: reads the registry's `admin` global directly (`AppGlobal.getExBytes`).                           |
| **Operator**          | Registry `operator` global (set by admin via `setOperator`)                                                 | Registry `createPeriod`: `Txn.sender === operator`. Period edits: read the registry's `operator` global directly (`AppGlobal.getExBytes`). |
| **Voter / Delegatee** | Committee membership (voting power) + `delegations` box                                                     | Period `vote()`: sender is the voter, or the voter's registered delegatee (verified via `registry.getDelegate`).                           |

The period app resolves `admin` and `operator` directly from registry app's global state, so role identity lives only on the registry — no per-period copies to keep in sync, and no inner call or extra transaction in the group.

### Permission matrix

| Action                                                                                                                                     | Admin | Operator | Anyone |
| ------------------------------------------------------------------------------------------------------------------------------------------ | :---: | :------: | :----: |
| `registerCommittee` / `unregisterCommittee` / `ingestGovs` / `uningestGovs`                                                                |   ✓   |          |        |
| `setOperator`, `setAdmin`, `setXGovRegistryApp`, `setFracRegistryApp`, `setLastPeriodId`                                                   |   ✓   |          |        |
| `uploadPeriodApprovalPartial` (period bytecode), `withdrawALGO`, update/delete registry app code (`UpdateApplication`/`DeleteApplication`) |   ✓   |          |        |
| `mirrorXGovDelegation` / `importFracDelegations`                                                                                           |   ✓   |          |        |
| `createPeriod` (spawn period app)                                                                                                          |       |    ✓     |        |
| Period `editPeriod` / `addTopic` / `editTopic` / `removeTopic` / `setReady` / body uploads                                                 |       |    ✓     |        |
| Update/delete period app code (`UpdateApplication`/`DeleteApplication`), period `withdrawALGO`, `deleteTopicBodies`                        |  ✓¹   |          |        |
| Registry `setVotingAccount` (delegate)                                                                                                     |       |          |   ✓²   |
| Period `vote()` / `canVote`                                                                                                                |       |          |   ✓³   |

¹ Resolved from the registry's `admin` global; deleting the period app code and `deleteTopicBodies` also require the period be **not ready**.\
² Authorization = the `govAddress` itself **or** its current delegatee (matches xGov registry rule).\
³ Sender must be the voter or the voter's delegatee, and the account must have voting power.

## Registry lifecycle

```
deploy (creator = admin)
  └─ setOperator / setXGovRegistryApp / setFracRegistryApp
  └─ uploadPeriodApprovalPartial ……… chunk-upload GGovPeriod approval bytecode into box `Pap`
  └─ setLastPeriodId(15) ……………………… seed counter to continue contiguous numbering after legacy periods
committee setup
  └─ registerCommittee ……………………… allocate metadata + committee superbox
  └─ ingestGovs (repeat, ascending by accountId) …… append members; complete when ingestedVotes == totalVotes
  └─ uningestGovs (descending) / unregisterCommittee (only when ingestedVotes == 0)
delegation setup
  └─ mirrorXGovDelegation …………………… seed a delegation from the xGov registry (never overwrites a local one)
  └─ importFracDelegations ………………… point a batch of frac escrow accounts at their instance app (overwrites)
period creation
  └─ createPeriod(committeeId, start, end, mbrPayment) → spawns GGovPeriod app  (operator only)
```

`createPeriod` requires the committee to be complete (`ingestedVotes == totalVotes`) and the
`Pap` bytecode box present. It: increments `lastPeriodId`; reads the approval bytecode (two 4 KB
pages, since a period approval can be up to 8 KB); creates the period app via inner txn with
max program pages + reserved global schema headroom; funds its MBR from `mbrPayment`; inner-calls
`period.init(...)`; and writes the `p<periodId>` summary box.

### Registry state

**Global:** `admin` (Account), `operator` (Account), `xGovRegistryApp` (Application, init 0), `fracRegistryApp` (Application, init 0),
`lastCommitteeId` (uint, init 1 — 0 is the "no committee" sentinel), `lastPeriodId` (uint, init 0),
`lastAccountId` (uint, init 0). Declared with generous `stateTotals` headroom.

**Boxes:**

| Prefix / key        | Contents                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `c<CommitteeId:32>` | `CommitteeMetadata` (numericId, member/vote totals, ingestedVotes, xGov registry id) |
| `S<numericId>…`     | Committee member superbox (`AccountIdWithVotes[]`)                                   |
| `a<Account>`        | `GGovAccount` (uint32 accountId + per-committee offset hints)                        |
| `p<Uint32>`         | `GGovPeriodSummary` { appId, votingStart, votingEnd, numTopics, ready }              |
| `d<Account>`        | Forward delegation: delegator → delegatee                                            |
| `D<Account>`        | Reverse index: delegatee → delegator[] (single-read "who delegated to me")           |
| `Pap`               | GGovPeriod approval bytecode (admin-uploaded; upgradable without registry redeploy)  |

## Period lifecycle

```
init ─────────► EDITABLE ──setReady(true)──► READY ──[votingStart, votingEnd)──► VOTING
(inner call,    (operator edits)   ▲                (votes accepted)
 once only)                        └──setReady(false), only if no votes cast──┘

deleteApplication: admin, only while !ready → deletes boxes, removePeriodSummary, closeRemainderTo
```

- **`init`** — inner ARC-4 call from `createPeriod`; guarded by `registryApp === 0` (once) and
  `Txn.sender === creatorAddress` (the registry app account). Records registryApp, periodId,
  committeeId, voting window.
- **Editable** (`!ready`) — operator sets the window (`editPeriod`), manages topics
  (`addTopic`/`editTopic`/`removeTopic`), and chunk-uploads period/topic body JSON. Every
  structural change mirrors the summary back to the registry via inner call.
- **`setReady(true)`** — locks all edits and enables voting. Rejects if the `GGovVoteCast` event
  for the topic shape would exceed the 1024-byte log limit (`ERR:GP_UV`) — a period that could
  never be voted on. `setReady(false)` is allowed only if no votes exist (`ERR:GP_VE`).
- **Voting** — `vote()` requires `ready` and `votingStart ≤ now < votingEnd`.
- **Delete app code** (`DeleteApplication`) — admin-only, only while `!ready`; reclaims box MBR and closes the balance out.

### Period state

**Global:** `registryApp` (uint, 0 = uninitialised), `periodId`, `votingStart`, `votingEnd`,
`ready` (bool), `committeeId` (32 bytes), `firstVotingRound` / `lastVotingRound` (indexer hints).
The registry reserves extra program pages + global schema so the period can grow to the AVM
ceiling without a registry redeploy.

**Boxes:** `o` topicOptionsArr, `t` topicVotesArr (parallel to `o`, mutated per vote), `P` period
body JSON, `T<Uint32>` per-topic body JSON, `v<Account>` `GGovVoteRecord` { isDelegated, topicVotes[][] }.

## Cross-contract trust boundaries

| Direction                                 | Call                                                                                   | Guard                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Registry → Period                         | `createPeriod` spawns app + inner-calls `init`                                         | `init`: `registryApp === 0` and sender is the registry app account.                                                |
| Period → Registry                         | `updatePeriodSummary` / `removePeriodSummary`                                          | `Global.callerApplicationId === summary.appId` — only the registered period app can mutate/remove its own summary. |
| Period → Registry                         | `admin` / `operator` global reads (`AppGlobal.getExBytes`)                             | Direct state reads (no inner call); role identity stays authoritative on the registry.                             |
| Period → Registry                         | `getDelegate` / `getGovVotingPower`                                                    | Readonly inner calls; delegation and voting power stay authoritative on the registry.                              |
| Registry → Fractional Delegation Registry | `importFracDelegations` which, per escrow: inner-calls `getEscrow` and adds delegation | Readonly reads; each escrow must be registered to a Fractional Delegation Instance.                                |
| Registry → Fractional Delegation Registry | `setVotingAccount`: `getAccount` fallback when the delegator has no gGov account       | Readonly read; needs `fracRegistryApp` set, else the delegator is simply unknown (`ERR:A_NX`).                     |
| Fractional Delegation Instance → Registry | `vote` / `canVote`: `getDelegate` when the sender is not the voter                     | Readonly read; user delegation stays authoritative here, shared with gGov period voting.                           |

Deleted periods set their summary `appId` to 0 implicitly by removal, so period-list reads filter them out.

## Delegation

xGov-compatible: `setVotingAccount` reuses the xGov registry's `set_voting_account(address,address)`
selector, mapping (xgovAddress, votingAddress) → (delegator, delegatee). `votingAddress ==
xgovAddress` (or zero) clears the delegation. Only existing accounts may delegate; self- and
zero-address delegation are rejected. Forward (`d`) and reverse (`D`) indexes are kept in lockstep;
`mirrorXGovDelegation` (admin) seeds a delegation from the xGov registry without overwriting an
existing local one. `GGovDelegationSet` / `GGovDelegationCleared` events are emitted on change.

**"Existing account" spans both registries.** This registry is also the single source of truth for
fractional-delegation user delegations, so `setVotingAccount` accepts a delegator known to gGov (the
`a<addr>` box) **or** to the fractional-delegation registry (`getAccount` returns a non-zero
`accountId`). The gGov box is read first; only a miss falls through to one readonly inner call, and
only when `fracRegistryApp` is configured — a registry without it behaves exactly as before. This is
what lets a frac user who was never ingested onto a gGov committee delegate their AlgoQuarters
weight. The delegator check lives at the entry points (`setVotingAccount`, `mirrorXGovDelegation`,
`importFracDelegations`); the private `addDelegation` trusts them rather than paying the inner call
twice. Because only a frac-only delegator reaches that call, the SDK makes its fee opt-in:
`setVotingAccount({ fractionalOnly: true })`, on delegating and clearing alike.

Fractional delegation integrated: `importFracDelegations` (admin) wires the fractional-delegation
subsystem into gGov's delegation model: the so-called escrow accounts delegate¹ to fractional-delegation
instance apps. The instances represent the staking products, and the escrows are the product-owned accounts
that accrue gGov voting power. This way, the instance can cast pooled gGov votes on the escrows' behalf. \
¹ Unlike `mirrorXGovDelegation`, this overwrites any existing delegation.

## Voting mechanics

`vote(voterAccount, topicVotes: Uint32[][])`:

1. Period is `ready` and within the voting window.
2. If `sender != voter`: registry must report `sender` as the voter's delegatee, and `voter` must
   be referenced in the txn's foreign accounts (`Txn.accounts(1)`) so indexers observe the delegation.
3. Voting power = `registry.getGovVotingPower(committeeId, voter)`.
4. `topicVotes` has one row per topic; each row matches that topic's option count; **each row sums
   to the voter's full voting power** (`ERR:GV_VP`).
5. Re-votes overwrite: old tallies subtracted, new added. A delegatee **cannot** override a vote the
   voter cast directly (`isDelegated=false` record ⇒ `ERR:GV_OD`).
6. Emits `GGovVoteCast`; updates `first`/`lastVotingRound` and the `v<Account>` record.

`canVote(voter, sender)` is the read-only mirror of these checks, returning `[eligible, power]`.

## Conventions

- **Errors** — `ERR:CODE` string constants in `base/errors.algo.ts`, parsed at SDK build time into
  human-readable messages (e.g. `ERR:AUTH` unauthorized, `ERR:GP_RD` period is ready,
  `ERR:GV_VP` vote sum ≠ voting power).
- **Account IDs** — addresses map to uint32 IDs so member lists and offset hints store 4 bytes,
  not 32.
- **Budget** — `increaseBudget(n)` fires `n` no-op inner app calls to raise the opcode budget for
  heavy operations (e.g. large re-tallies).
- **Bulk reads** — `logCommitteePages`, `logPeriod`, `logVotingRecord`, `logPeriodSummaries`, etc.
  emit paged log lines so readers can reconstruct data larger than the 1024-byte ABI-return limit
  via simulate.
