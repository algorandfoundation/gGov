# Fractional Delegation Contract Architecture

Fractional (pro-rata) delegation on top of gGov for use by pooled and liquid staking products
(xALGO, tALGO, Reti).

Same **registry-as-factory** shape as the core gGov system: one durable registry app is the trust
root and instance deployer; each participating protocol gets its own **instance** app spawned via
inner transaction.

Protocol users' contributions are measured in **AlgoQuarters (AQ)**, a unit of stake over time (1 AQ = 1 ALGO staked for 3M rounds.) They are computed
offchain per-protocol, and represent the protocol users' relative weights over a committee's period. They are used to split the protocol's pooled gGov voting power among its users in a fair manner, relative to their stake contributions.
An instance snapshots gGov committee voting power for its **escrow** accounts
and maintains an internal AQ ledger; its users then cast **internal votes** weighted by AQ, which the
instance maps onto its escrows' gGov power and casts externally on the gGov period via delegation.

Source: `projects/contracts/smart_contracts/frac-delegation/`. See `ARCHITECTURE.md` for the gGov
registry/period contracts this builds on.

## Contracts

| Contract                 | File                             | Role                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FracDelegationRegistry` | `fracDelegationRegistry.algo.ts` | Global singleton + instance factory: frac-wide admin, default operator, gGov-registry pointer, account registry, instance registry, globally-unique escrow assignment, instance bytecode. Extends `BaseContract`.                            |
| `FracDelegationInstance` | `fracDelegationInstance.algo.ts` | One app per protocol: escrows, per-committee voting-power snapshots, AlgoQuarters ledger, per-period vote caches + records, and internal→external vote casting. Resolves its roles from the registry's global state. Extends `BaseContract`. |

The two contracts also read and drive the gGov side: instances call the **gGov registry**
(`getCommitteeMetadata`, `tryGetGovVotingPower`, `getAccount`) and **gGov period** apps
(`getPeriodShort`, live globals, and `vote`) to snapshot committees/periods and cast external votes.

## Roles & RBAC

The frac system defines two privileged roles, **admin** and **operator**, plus two structural
callers (the **registry app** itself, and the instance **creator** escape hatch). Internal voting
is open to any user having "AlgoQuarters" power and to that user's
delegatee, as recorded on the gGov registry (see **User delegation** below).

The **operator** is the working role that runs an instance's data pipeline: syncing committees and
periods from gGov, and ingesting/uningesting AlgoQuarters. It never moves ALGO, changes roles, or
upgrades code. Each instance has a local `operator` override; when unset (zero address) it falls
back to the registry's `defaultOperator`.

The **admin** is the root authority: it configures the registry (default operator, gGov-registry
pointer), uploads instance bytecode, spawns instances, registers escrows, withdraws ALGO, and
updates/deletes app code. There is a single frac-wide admin (the registry's `admin` global);
instances resolve the same admin by reading that global.

| Role                     | Source of truth                                                                                             | How it's checked                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**                | Registry `admin` global (defaults to `Global.creatorAddress`, rotatable via `setAdmin`, zero-addr rejected) | Registry: `Txn.sender === admin`. Instance: `resolveAdmin()` reads the registry's `admin` global directly, **or** `Txn.sender === creatorAddress` (creator escape hatch). |
| **Operator**             | Instance `operator` override, else registry `defaultOperator` (both admin-set)                              | Instance: `Txn.sender === resolveOperator()`.                                                                                                                             |
| **Registry (as caller)** | The instance's bound `registryApp` global                                                                   | Instance: `Global.callerApplicationId === registryApp` (used by `registerEscrow`, `getOrCreateAccountWithInstance`).                                                      |
| **Voter**                | Ingested AlgoQuarters in the period's committee (`accountAq` box)                                           | Instance `vote`: `voterAccount` resolves to a frac account with non-zero AQ.                                                                                              |
| **Delegatee**            | The **gGov registry**'s `delegations` box                                                                   | Instance `vote`: when `Txn.sender !== voterAccount`, `GGovRegistry.getDelegate(voterAccount) === Txn.sender`, and the voter must be at `Txn.accounts(1)`.                 |

> **Direct global-state reads.** Like gGov’s period contracts, frac instances resolve roles by reading the registry app’s global state
> (`op.AppGlobal.getEx*` on `admin` / `defaultOperator` / `gGovRegistryApp`) — no cross-contract
> call, no extra transaction. `vote` reads the gGov period app's live globals (`ready`, window,
> `committeeId`) the same way.

The **creator escape hatch** is permanent: the spawning registry is the instance's `creatorAddress`,
so it always passes `ensureCallerIsAdmin`. This is a safety net if an instance is rebound to an
unintended registry via `setRegistryApp` — bind the new registry _before_ deleting the old one, never
after, or admin auth can be bricked.

### Permission matrix

| Action                                                                                                              | Admin | Operator | App caller | Anyone |
| ------------------------------------------------------------------------------------------------------------------- | :---: | :------: | :--------: | :----: |
| Registry `setAdmin` / `setDefaultOperator` / `setGGovRegistryApp` / `withdrawALGO`                                  |   ✓   |          |            |        |
| Registry `uploadInstanceApprovalPartial`, update/delete registry app code (`UpdateApplication`/`DeleteApplication`) |   ✓   |          |            |        |
| Registry `createInstance` (spawn instance app), `registerEscrow`                                                    |   ✓   |          |            |        |
| Registry `getOrCreateAccountWithInstance`                                                                           |   ✓   |          |     ✓¹     |        |
| Instance `setOperator` / `setRegistryApp` / `withdrawALGO`                                                          |  ✓²   |          |            |        |
| Update/delete instance app code (`UpdateApplication`/`DeleteApplication`)                                           |  ✓²   |          |            |        |
| Instance `registerEscrow`                                                                                           |  ✓²   |          |     ✓³     |        |
| Instance `syncCommittee` / `startAqIngest` / `ingestAq` / `uningestAq` / `syncPeriod`                               |       |    ✓     |            |        |
| Instance `vote` (internal vote)                                                                                     |       |          |            |   ✓⁴   |
| Registry/instance `getAccount` / `getCommitteeAq` / `logPeriodVotingState` / `canVote` / readonly getters           |       |          |            |   ✓    |

**App caller** = a structural (inter-app) caller rather than a keyed role. ¹ The bound instance app
(production path, as `Txn.sender`) or the admin (bootstrap). ² Resolved via the registry `admin`
global, or the creator escape hatch. ³ The bound registry app (`Global.callerApplicationId ===
registryApp`). ⁴ Any account with ingested AlgoQuarters in the period's committee, or that account's
gGov-registry delegatee.

## Registry lifecycle

```
deploy (creator = admin = defaultOperator)
  └─ setGGovRegistryApp / setDefaultOperator
  └─ uploadInstanceApprovalPartial ……… chunk-upload FracDelegationInstance approval bytecode into box `Iap`
instance creation
  └─ createInstance(name, mbrPayment) → spawns FracDelegationInstance app  (admin only)
escrow assignment
  └─ registerEscrow(instanceNumId, account) → globally-unique escrow → instance, mirrors into instance
```

`createInstance` requires the `Iap` bytecode box present; it increments `lastInstanceNumId`, reads
the approval bytecode (two 4 KB pages, up to 8 KB), creates the instance app via inner txn with max
program pages + reserved global-schema headroom, funds its MBR from `mbrPayment`, invokes the
convention `createApplication(instanceNum, name)` create call, and writes the `i<instanceNum>` record.
`registerEscrow` enforces one-instance-per-escrow globally (via the `e<Account>` box) and inner-calls
`instance.registerEscrow` to mirror the escrow into the instance's own list.

### Registry state

**Global:** `admin` (Account), `defaultOperator` (Account, init creator), `gGovRegistryApp`
(Application), `lastAccountId` (uint, init 0), `lastInstanceNumId` (uint, init 0). Declared with
generous `stateTotals` headroom.

**Boxes:**

| Prefix / key | Contents                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `a<Account>` | `FracRegAccount` (uint32 accountId + numeric IDs of instances the account appears in)           |
| `i<Uint16>`  | `FracInstance` (appId, name, numAccounts, numEscrows)                                           |
| `e<Account>` | Escrow assignment: escrow → instance numeric ID (presence enforces global uniqueness)           |
| `Iap`        | FracDelegationInstance approval bytecode (admin-uploaded; upgradable without registry redeploy) |

## Instance lifecycle

```
createApplication ─► escrows registered ─► syncCommittee ─► startAqIngest ─► ingestAq* ─► syncPeriod ─► vote*
(once, by registry)   (registry/admin)     (operator)        (operator)       (operator)   (operator)   (AQ holders)
```

- **`createApplication`** — convention create call, invoked once by the registry during app
  creation. Records `instanceNumId` + `name`; `registryApp` is seeded from `Global.callerApplicationId`
  (the spawning registry); `operator` defaults to zero (registry fallback).
- **`registerEscrow`** — append-only; escrow accounts added via the registry (normal path, keeps the
  registry's `numEscrows` in sync) or the admin escape hatch.
- **`syncCommittee(committeeId)`** — operator snapshots each escrow's gGov voting power for a committee
  (`tryGetGovVotingPower`, so non-members contribute 0). Requires ≥1 escrow and a fully-ingested gGov
  committee (`mustBeComplete`). Idempotent; rebuilt from scratch each call.
- **AlgoQuarters** — `startAqIngest(committeeId, totalAq, totalAccounts)` opens a ledger against a
  synced committee; `ingestAq` accumulates per-account AQ (one inner call to the registry's
  `getOrCreateAccountWithInstance` per account, minting IDs and linking accounts to the instance);
  `uningestAq` walks a batch back and reclaims box MBR. Ledger is complete when
  `ingestedAq == totalAq && numAccounts == totalAccounts`. The total is frozen once any AQ is ingested.
- **`syncPeriod(periodApp)`** — operator snapshots a gGov period's identity + topic shape and stands up
  zero-filled vote caches (`periodVoteCache` + one `periodEscrowVotes` box per snapshotted escrow).
  Requires the committee synced locally and the period marked **ready** on the gGov side. Re-syncable
  only while no vote has landed.
- **`vote(voterAccount, periodId, topicVotes)`** — an AQ holder (or its delegatee) casts an internal
  vote; the instance maps the internal tally onto its escrows and re-casts externally on gGov. See
  **Voting** below. `canVote(voterAccount, senderAccount, periodId)` is its readonly, non-throwing
  mirror.
- **`setRegistryApp`** — admin migration path; validates the new registry exposes an `admin` key before
  binding, so a bad app ID can't brick role resolution.
- **Update/delete app code** — resolved admin only. (Delete does **not** yet reclaim box MBR — see Status.)

### Instance state

**Global:** `registryApp` (uint, init `Global.callerApplicationId`), `operator` (Account, init zero =
registry fallback), `instanceNumId` (Uint16), `name` (string). Registry reserves extra program pages +
global-schema headroom so the instance can grow without a registry redeploy.

**Boxes:**

| Prefix / key         | Contents                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `escrows`            | `Account[]` — this instance's escrows, append-only                                                             |
| `c<CommitteeId:32>`  | `FracInstanceCommittee` (committee numId, per-escrow votes, total) — snapshot from gGov                        |
| `p<Uint32>`          | `FracInstancePeriod` (period app, committee, topic shape, escrow count) — snapshot from gGov                   |
| `V<Uint32>`          | `FracPeriodVoteCache` (aggregate `internal` AQ + `ggovTotals` external [topic][option] tallies)                |
| `E<[Uint32,Uint8]>`  | `FracEscrowVotes` (one escrow's external gGov votes for a period)                                              |
| `A<Uint16>`          | `FracCommitteeAq` (per-committee AQ ledger: totals + running tallies)                                          |
| `q<[Uint32,Uint16]>` | Per-[account, committee] ingested AlgoQuarters (`Uint32`)                                                      |
| `r<[Uint32,Uint32]>` | `FracVotingRecord` (`isDelegated` + rows) — one account's internal vote for a period (`[periodId, accountId]`) |

## Voting

`vote(voterAccount, periodId, topicVotes)` is the heart of this contract. Any account with ingested
AlgoQuarters in the period's committee may call it, as may that account's delegatee; there is no
operator/admin gate.

1. **Live gGov gates, not the snapshot.** `ready`, the voting window, and the bound `committeeId` are
   re-read straight off the period app's global state (`getEx*`), not trusted from the `syncPeriod`
   record — until the instance's first external cast lands, the gGov operator could still un-ready and
   edit the period out from under the snapshot.
2. **Complete AQ ledger.** The committee's ledger must be fully ingested (`ingestedAq == totalAq`);
   weight is split against `totalAq`, so a half-ingested ledger would inflate early voters' shares.
3. **Delegation.** If `Txn.sender !== voterAccount`, the **gGov registry** must name the sender as the
   voter's delegatee (`getDelegate`, one readonly inner call), and the voter must be referenced at
   `Txn.accounts(1)` so delegated votes are visible to indexers. See **User delegation** below.
4. **Weight & shape.** The voter's AQ weight is one registry `getAccount` (readonly) + one O(1)
   `accountAq` box read. Every topic row must sum to the voter's **full** AQ weight (as
   `GGovPeriod.vote` requires); abstaining is voting the last option.
5. **Internal tally.** Votes accumulate into `periodVoteCache.internal` in AlgoQuarters. Re-votes
   overwrite: the account's previous rows (from its `r` record) are subtracted before the new rows are
   added. A delegatee may **not** overwrite a record the owner cast directly (`errGGovCannotOverride`).
6. **Map internal → external.** The internal AQ tally is mapped onto the committee's total escrow gGov
   power against the `totalAq` denominator: non-last options floor-divide (`tally · totalVotes /
totalAq`); the **last option takes the remainder**, so all AQ that never voted plus rounding dust
   fold into it. By operator convention the last option must be **Abstain**.
7. **Cast across escrows.** When the mapping changes, the per-topic target is packed across escrows
   greedily (each option consumes escrow capacity in escrow order via exact range-overlap, no division),
   so every escrow's row sums to its full gGov power. Each escrow whose rows changed re-votes through a
   **delegated external inner call** to `GGovPeriod.vote` — the escrow is the voter and the instance app
   is the delegatee (passed at `Txn.accounts(1)`). Per-escrow detail is cached in `periodEscrowVotes`.
8. **Emit + persist.** Emits `FracVoteCast` (mirrors `GGovVoteCast`, `voter` + `sender`), then writes
   the account's `r` record — including `isDelegated` — and the updated cache.

### User delegation

There are **two** delegations in play, and both live in the gGov registry's `delegations` box:

| Delegation                    | Purpose                                                  | Set by                                   |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| escrow → instance app address | lets the instance cast pooled gGov votes for its escrows | escrow, or admin `importFracDelegations` |
| frac user → another account   | lets a delegatee cast that user's **internal** frac vote | the user (`set_voting_account`)          |

The gGov registry is the single source of truth for both, so one delegation covers a user's gGov
period vote and their frac instance vote under identical rules — the model is a direct port of
`GGovPeriod.vote`: `getDelegate` must name the sender, the voter must be at `Txn.accounts(1)`, and a
record with `isDelegated == false` is final as far as a delegatee is concerned.

For this to work for frac users, `GGovRegistry.set_voting_account` accepts a delegator that is known
to **either** registry: the gGov `accounts` box is checked first, and only on a miss does the registry
inner-call the frac registry's `getAccount` (requires its `fracRegistryApp` to be configured). Without
that, a frac-only user — an AQ holder who was never ingested onto a gGov committee — could not
delegate at all. See `ARCHITECTURE.md` § Delegation.

**Prerequisites & consequences.** Escrows must have delegated their gGov voting power to this instance's
app address (via the gGov registry's `set_voting_account`) and must **never** vote directly — a direct
gGov vote is unoverridable (`errGGovCannotOverride`) and would brick external casting for the period.
Because gGov demands an account's full power on every topic, the **first** internal vote — however small
— casts every escrow on every topic (mostly onto Abstain), which makes the gGov period's tallies
non-zero and permanently locks it against `setReady(false)` / `editPeriod`.

## Cross-contract trust boundaries

| Direction                | Call                                                                                                                                          | Guard                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry → Instance      | `createInstance` spawns app + convention `createApplication`; `registerEscrow` mirrors into instance                                          | Instance seeds `registryApp` from the creating app; `registerEscrow` accepts the bound registry caller or admin.                               |
| Instance → Registry      | `resolveAdmin` / `resolveOperator` read registry globals; `getOrCreateAccountWithInstance` / `getAccount` inner calls                         | Role reads need only the registry's `admin` global to exist; `getOrCreateAccountWithInstance` requires caller to be the instance app or admin. |
| Instance → gGov registry | `syncCommittee`: `getCommitteeMetadata` (complete) + `tryGetGovVotingPower`; `vote`/`canVote`: `getDelegate` when the sender is not the voter | gGov registry resolved from frac registry's `gGovRegistryApp` global; delegation stays authoritative there.                                    |
| gGov registry → Registry | `set_voting_account`: `getAccount` fallback for a delegator with no gGov account                                                              | Readonly read; only reached when the gGov `accounts` box misses and `fracRegistryApp` is set.                                                  |
| Instance → gGov period   | `syncPeriod`: `getPeriodShort` + `periodId`/`ready` globals; `vote`: live `ready`/window/`committeeId` globals + delegated `GGovPeriod.vote`  | Period must exist and be ready; `vote` casts each escrow with the escrow as gGov voter and the instance app as delegatee.                      |

## AlgoQuarters model

External gGov voting power is held by an instance's **escrow** accounts; `syncCommittee` snapshots how
much each escrow holds in a committee. **AlgoQuarters** are the off-chain-computed internal weight of a
protocol's individual users over that committee's period. The AQ ledger (`startAqIngest` → `ingestAq`)
records each user's share. Internal votes are split pro-rata against `totalAq`, and the aggregate is
what escrows cast as the external gGov vote. The vote cache separates the two: `internal` (AQ-weighted
internal tally) and `ggovTotals` (external votes actually cast on gGov), with per-escrow detail in
`periodEscrowVotes`. Keying AQ and vote records by numeric account/committee IDs (not 32-byte addresses)
keeps a user's own weight a single O(1) box read and saves box MBR.

## Status & conventions

- **Internal voting is implemented**, including user-to-user delegation: `vote` maps AQ-weighted
  internal votes onto escrow gGov power and casts them externally via delegation. Two rough edges
  remain:
  - **`uningestAq` has no live-vote guard yet.** Since `vote` now reads AQ, draining a committee that an
    open period has votes against would corrupt the tally denominator. Until the guard lands (mirroring
    `syncPeriod`'s `cacheHasVotes`), operators must not uningest a committee with an open, voted-on period.
  - **Instance `deleteApplication` does not reclaim box MBR yet** (TODO): unbounded BoxMaps need a paged
    batch-delete before a `closeRemainderTo` sweep, as `GGovPeriod.deleteApplication` does. The registry's
    own delete likewise leaves MBR locked (documented rare action).
- **Abstain-is-last convention.** The last option of every topic absorbs non-voting AQ and rounding
  remainder in the internal→external mapping, so operators must make the last option Abstain.
- **Escrow delegation prerequisite.** Escrows must delegate to the instance app on the gGov registry and
  never vote directly, or external casting breaks (see Voting).
- **Delegation source of truth.** Both escrow→instance and user→user delegations live in the gGov
  registry's `delegations` box; frac holds none of its own.
- **Events** — `FracVoteCast` (instance `vote`) mirrors gGov's `GGovVoteCast`, carrying both `voter`
  and `sender`.
- **Errors** — `ERR:CODE` constants in `base/errors.algo.ts` (e.g. `ERR:FE_AS` escrow already assigned,
  `ERR:FA_NS` AQ ingest not started, `ERR:RM` registry configuration missing), parsed into
  human-readable SDK messages at build time.
- **Bulk reads** — `logAccounts`, `logPeriodVotingState` emit paged log lines for simulate with
  `allowMoreLogging`, sidestepping the 1024-byte ABI-return limit.
- **SDK** — `projects/frac-delegation-sdk/` wraps these contracts (reader/writer split), mirroring the
  gGov SDK layout.
