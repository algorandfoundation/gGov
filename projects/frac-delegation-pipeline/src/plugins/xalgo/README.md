# xALGO pipeline

AlgoQuarters for **xALGO** holders — [Folks Finance's liquid staking token](https://github.com/Folks-Finance/algo-liquid-staking-contracts). The consensus app (`1134695678`) stakes the pooled ALGO on its **proposers**, which are the committee escrows; every circulating xALGO unit is a pro-rata claim on that ALGO, growing in value as block rewards accrue.

> **Status: implemented.** Escrow recognition (stage 1) and the AlgoQuarters calculation (stage 3) both run through `XalgoPipelinePlugin`; the calculation is covered by the invariant tests in `test/xalgo/` and checked against mainnet with the scripts under [Checking the work](#checking-the-work).

## Why xALGO is not tALGO

Crediting raw xALGO balances would be wrong for most of the supply. On 2026-08-19, of ~227.6M circulating xALGO, **~135.4M (≈60%) sits in the Folks Finance v2 xALGO lending pool** (app `2611131944`). Most of it is **ultrastake** collateral: the user stakes ALGO, the freshly minted xALGO is deposited into the pool, the user's _loan escrow_ receives the deposit receipt token **fxALGO**, and the user borrows ALGO against it (a 2x ultrastake of 200 ALGO stakes 400 ALGO-worth of xALGO and borrows 200 ALGO back — [stake](https://algo.surf/group/HF1lMDpTx75W+wRjAzZd0L7dtcVuwQX9znLxKy6bklY=/64215436/transactions), [unstake](https://algo.surf/group/mhv2uH3UspEBGt3SePml6A9uLDzn2uKp+dkQGL2LZMI=/64215568/transactions)). The pool address cannot vote, so without seeing through it 60% of the instance's gGov power would fold into Abstain, and every ultrastaker would be weightless.

## Methodology

Shared conventions apply unchanged ([`src/aq`](../../aq/README.md)): windows are `[periodStart, periodEnd)`, a snapshot at `R` is the state after all transactions in rounds `< R`, accrual is exact bigint micro-unit·rounds floored **once per beneficiary** at the final conversion, accounts below 1 AQ are omitted, every value is asserted to fit uint32, the replay fails loud, and snapshots are chained verify-first at 1M-round boundaries.

### 1. Custody-based attribution — each xALGO unit counted exactly once, at every instant

| Who holds the xALGO                                                                                                                                        | Who is credited                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A wallet, a DEX pool, any other contract                                                                                                                   | The holding address itself (tALGO's LP policy: real accounts that can't vote fold into Abstain; DEX pools hold ≲2%)                                                                                                                                                                                                                                |
| The Folks xALGO pool (`YO4ZOK…`)                                                                                                                           | **fxALGO holders, pro rata by fxALGO balance.** Numerator: the pool's _physical_ xALGO. Denominator: circulating fxALGO (total − the pool's own reserve). xALGO the pool has lent out is credited to whoever holds it; depositors share that reduction proportionally (~0.5% today). Conserved, no negative balances, no loan-state history needed |
| A Folks escrow holding fxALGO (loan ALGO_EFFICIENCY `971389489` = ultrastake, loan GENERAL `971388781`, Deposits `971353536`, DepositStaking `1093729103`) | **The escrow's owner.** An ultrastaker is credited the full leveraged collateral (gross — 400 ALGO-worth on 200 own); a user's escrows sum before flooring                                                                                                                                                                                         |
| fxALGO held by anyone else (wallets, Tinyman/Pact "lending pool" LPs)                                                                                      | The holding address itself                                                                                                                                                                                                                                                                                                                         |

Excluded from eligibility (tracked, reported in `excluded`, never credited): the **xALGO app address** `4MBB6O…` (creator + reserve: un-minted supply, where burns land) and the **pool address** (its xALGO is redistributed above; its fxALGO is the un-minted fxALGO reserve, so it also leaves the denominator). The ultrastake router `StakeAndDeposit` (`2633147490`) holds nothing at rest.

**Formula.** For beneficiary `a`, with `X_a(t)` its direct xALGO, `F_a(t)` the fxALGO it holds directly or through its escrows, and `ratio(t) = poolXalgo(t) / fxCirculating(t)` (0 while `fxCirculating = 0`):

```
microXalgoRounds_a = ∫ X_a(t) dt  +  ∫ F_a(t) · ratio(t) dt          over [periodStart, periodEnd)
AQ_a               = floor( microXalgoRounds_a × rate / RATE_SCALER / 3e12 )
```

Conservation: `Σ_a microXalgoRounds_a + unattributed = ∫ circulatingXalgo dt`, where the unattributed part is pool xALGO during intervals with no fxALGO in circulation plus fixed-point dust (below).

### 2. Time-exact pool share: a cumulative index

The pool's split among fxALGO holders drifts with every deposit, withdrawal, borrow and repayment, so a single ratio per window would let one large xALGO borrow re-weight the whole window. Instead the replay keeps the **reward-per-share** index `R(t) = ∫ ratio dt` as fixed-point bigint (`INDEX_SCALE = 1e18`):

- the xALGO and fxALGO transfer streams are merged by `(round, intraOffset)`; inner transactions inherit their outer transaction's offset, so a deposit's xALGO-in and fxALGO-out are one instant;
- before any event of a new round is applied: `R += poolXalgo × Δrounds × INDEX_SCALE / fxCirculating` — one floor per step;
- every fxALGO holder (the pool excepted) earns `fxalgo × ΔR` for each interval its fxALGO balance is constant, settled lazily when it changes and at `periodEnd`;
- direct xALGO accrues exactly as in tALGO (`xalgo × rounds`, settled lazily), skipping excluded addresses;
- escrow balances fold into their owners **before** the single floor.

Because `R` only advances between distinct rounds and every holder is settled before its own balance changes, `Σ_h fxalgo_h × ΔR` telescopes to `poolXalgo × Δrounds` per step — conservation holds up to the floor. Each step leaves a holder short by less than `fxalgo × steps / 1e18` µxALGO·rounds: realistically ~1e-11 AQ, always downward.

### 3. Rate: one per window, from the consensus app's own events

`rate = algoBalance / xAlgoCirculatingSupply` is only readable live (`get_xalgo_rate`), so past rates come from the ARC-28 events the app logs on every mint and burn (~7.8k calls per 1M rounds, so the first event is effectively at `periodStart`):

| Event                                                                                         | Selector   | Log                   | Exact?                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `ImmediateMint(address sender, address receiver, uint64 algo, uint64 xalgo)`                  | `5af2d40e` | 84 B                  | embeds `premium` (0 today, capped 1%) — the plugin warns when the live `premium` global is non-zero |
| `Burn(address sender, uint64 xalgo, uint64 algo)`                                             | `45a62f7a` | 52 B, **xALGO first** | yes                                                                                                 |
| `ClaimDelayedMint(byte[36] box, address minter, address receiver, uint64 algo, uint64 xalgo)` | `27017652` | 120 B                 | yes                                                                                                 |

`rate = algo × 1e12 / xalgo` of the first such event in the window, reported as the 12-dp `rate` manifest string. Same approximation and same justification as tALGO: xALGO/ALGO drifts ~0.4%/month, the drift is symmetric across holders, and it does not compound (re-fetched per window). Sanity bound `1.0 ≤ rate < 2.0`. Verified on mainnet: 200 ALGO → 163.597082 xALGO (round 64215385), 163.597082 xALGO → 200.000015 ALGO (64215402), 400 ALGO → 327.194084 xALGO (64215436), 327.194083 xALGO → 400.000181 ALGO (64215568).

**Delayed mints** (`delayed_mint` / `claim_delayed_mint`, 320-round wait) earn nothing until claimed — no xALGO exists yet. Negligible, and `can_delay_mint = 0` today. Documented, not modelled.

### 4. Escrow → owner: candidate-driven, cached

A Folks escrow is a fresh account rekeyed to its app; the owner sits in its local state (key `u` for the loan apps, `ua` for Deposits and DepositStaking) — and disappears when the escrow closes (e.g. a full un-ultrastake). Both sources of truth are immutable, so each resolution happens once and is cached in `snapshots/xalgo/beneficiaries.json`:

1. Candidates = every address holding fxALGO at `periodStart` or receiving fxALGO in the window, minus the pool, minus the cache.
2. `lookupAccountByID(addr).includeAll(true)`: local state (open **or closed** — the Indexer still reports the app id and `opted-in-at-round`) in one of the four escrow apps makes it an escrow.
   - Open: owner = the `u`/`ua` bytes.
   - Closed: one single-round lookup at `opted-in-at-round` for the creation payment — `pay` from the owner to the app address with note `"la " / "da " / "fa " + 32-byte escrow pubkey` (the `create_loan` / `add_deposit_escrow` argument; removal notes are `"lr " / "dr " / "fr "`). Absent or ambiguous → throw, never guess.
   - Neither → `self`. What an escrow factory this plugin does not see through looks like is _several_ holders rekeyed to the same address (each Folks app rekeys every escrow to its own account), or any holder rekeyed to one of Folks' other loan apps (`FOLKS_UNTRACKED_LOAN_APPS`); both are warned about, a wallet rekeyed 1:1 to a cold key is not. On mainnet today this flags exactly the two Tinyman v2 lending pools and a swap router's dust escrows — all credited to themselves by policy.
3. Verified equal on live escrows: note-payment sender == local-state owner; `verify-xalgo-balances` re-checks every cached owner against live local state (3333 escrows across the three apps, 0 disagreements, 2026-08-19).

Why not a bulk scan of all creation notes: note-prefix queries on the GENERAL loan app time out on the Indexer even in 1M-round windows, while the per-candidate calls are indexed and take ~0.1 s each — and there are only a few thousand candidates, resolved once.

### 5. Verification

`verifyAgainstChain` replays both assets from the newest committed snapshot to the live round and diffs every holder against `lookupAssetBalances` (as tALGO), then cross-checks the beneficiary cache: one paged `searchAccounts().assetID(fxALGO).currencyGreaterThan(0)` yields `auth-addr` and local state for every current fxALGO holder — a cached escrow must show the same owner live; a holder rekeyed to a tracked app but missing from the cache is an error; a holder rekeyed to an untracked app is a warning. Snapshot stats report the pool's share of circulating xALGO (~60%) and the pool ratio `inPool / fxCirculating` (expect 0.99–1.01): a drift far from 1 is the smoke signal that the pool moved xALGO for a reason this methodology does not know about.

## Files

Snapshot `snapshots/xalgo/<round>.json` — raw custody, escrows under their own address:

```json
{
  "round": 63000000,
  "balances": { "AAAA…": { "xalgo": "1000000", "fxalgo": "0" } },
  "excluded": {
    "4MBB…": { "xalgo": "9772442181860000", "fxalgo": "0" },
    "YO4Z…": { "xalgo": "135373684170000", "fxalgo": "9863968636640000" }
  }
}
```

Resolution cache `snapshots/xalgo/beneficiaries.json`, sorted by address, append-only:

```json
{
  "entries": [
    { "address": "AJLB…", "kind": "escrow", "owner": "JPEG…", "app": 971389489, "optInRound": 64215436 },
    { "address": "XE2V…", "kind": "self" }
  ]
}
```

Algoquarters follow the shared schema with `protocol: "folks-xalgo"` plus `rate`, the fixed xALGO/ALGO rate for the window (12-decimal fixed-point string).

## Plugin overrides

| Override            | Default                     | Purpose                                                     |
| ------------------- | --------------------------- | ----------------------------------------------------------- |
| `appId`             | `1134695678`                | consensus app (escrow recognition + rate events)            |
| `snapshotsDir`      | `<package>/snapshots/xalgo` | snapshots and `beneficiaries.json`                          |
| `allowLargeHolders` | `false`                     | downgrade the >40%-of-circulating holder check to a warning |

## Code structure

```text
index.ts           Plugin — escrow recognition (proposer boxes), calculateCommitteeAQ orchestration, snapshot/verify entry points
compute.ts         Attribution replay (direct accrual + pool index) and AQ conversion
ledger.ts          Applies transfers, opt-ins, close-outs to the {xalgo, fxalgo} balance map
beneficiaries.ts   Escrow → owner resolution and its cache
indexer.ts         Rate-event decoding and the first-event-in-window rate query
snapshot.ts        Snapshot store, (de)serialization, comparison, cold rebuild from asset creation
verify.ts          Live check — replay vs chain balances, cache vs live escrow local state
stats.ts           Supply/holder stats, pool ratio, large-holder check
exclusions.ts      Reserve and pool addresses
constants.ts       Ids, addresses, selectors, layouts, scalers — every value verified on mainnet
types.ts           Pipeline types
```

## On-chain reference (mainnet)

|                                                  |                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| xALGO ASA                                        | `1134696561`, total 1e16, 6 dp, created round 30058590; creator + reserve = app address `4MBB6O7EV2ZRIUKJT47B2NJ2BQPNJ3BQEQBPA7UN7MXWRG7U4OMPP6VOTY`                                                                                                                                                                                                            |
| Consensus app                                    | `1134695678`, created 30058558; globals `premium`, `fee`, `num_proposers`, `can_immediate_mint`, `can_delay_mint`; proposers in boxes `ap` + pubkey                                                                                                                                                                                                             |
| fxALGO ASA                                       | `2611138444` "Folks V2 xALGO", total 1e16, 6 dp, created 45366725; creator + reserve = pool address `YO4ZOK3AEX4YDMOBIYLQUYHO75YPCIOD24PR6KIAVHUW5TZ4OCPSXV6BQE` (app `2611131944`, created 45366638)                                                                                                                                                           |
| Escrow apps (address, owner key, creation round) | ALGO_EFFICIENCY `BZLK62AUHRSN5QJK2TFEN6WABGRI53YQOYHAE2KMIPNKM6G3G5JLZQ3RAE` `u` 25404033 · GENERAL `6VHIYVR7WV7Q6NL4GO43E3WVXXZMURG6XQWYOTOZNCI2X76OBC6ZG6SE2A` `u` 25404015 · Deposits `NWLEBGQX3OYPYVMI6DVGRLW7WVWX7BR5MA4JOEYUCATNLC2UCUQ6TOVD6Y` `ua` 25403231 · DepositStaking `U7PQBPSKLHB7ZWSWWQL26XUSUSSUNNNDQ24CZ676GP33LGY6LVELSPJDFU` `ua` 28685103 |
| fxALGO holders by `auth-addr` (2026-08-19)       | ALGO_EFFICIENCY 2345 · GENERAL 343 · Deposits 645 · DepositStaking 0 · other ~19, of 3352                                                                                                                                                                                                                                                                       |
| Volumes per 1M rounds                            | ~44k xALGO transfers · ~2.1k fxALGO transfers · ~7.8k consensus-app calls                                                                                                                                                                                                                                                                                       |

Plain stake/unstake for comparison: [stake 200 ALGO](https://allo.info/tx/group/Z0OVNBjmn5cyHKmu5Z%2BPnCySbEq%2FdIkfMkcabjD7XaU%3D), [unstake 163.597082 xALGO](https://allo.info/tx/group/CV%2BsUGUlxgH1wPb%2FiswUtXFk8ihT29KGhPnFYt96lQs%3D).

## Checking the work

```bash
pnpm xalgo-aq 60000000 63000000   # dry run of one window: builds/uses snapshots, resolves escrows, prints totals — ingests nothing
pnpm verify-xalgo-balances        # replay vs live chain balances + escrow owners vs live local state
pnpm test                         # invariants: conservation, see-through, escrow folding, single flooring, …
```

The plugin refuses a window whose `periodEnd` the chain has not reached yet: an open window would be replayed as far as the chain goes and its boundary snapshots written with state that is not final. The first call for a `periodStart` with no snapshot on disk rebuilds it from asset creation (xALGO from round 30058590, fxALGO from 45366725 — ~13 minutes); every later window starts from a committed snapshot and only scans its own 3M rounds (~5 minutes including escrow resolution). `snapshots/xalgo/` is committed so CI and teammates never pay the cold path. First window computed: `[60000000, 63000000)` → 8130 accounts, 275,523,604 AQ at rate 1.203132107809 (≈ 227.7M circulating xALGO × rate, as it should be), with the largest ultrastaker's owner on top at 3%.

## Open points

- Premium history: scan `UpdatePremium(uint64)` (`86219c29`) once to confirm it was always 0; if not, windows whose first event is an `ImmediateMint` overstate the rate by ≤1%. The plugin warns when the _live_ premium is non-zero and the rate came from a mint.
- DepositStaking's `ua` key is assumed from the Folks SDK, not verified on chain (no fxALGO holders there today).
- Integrators who create escrows without the note convention would make a closed escrow unresolvable → the replay throws; decide per case.
- `verify` warns about fxALGO holders that look like escrows of something this plugin does not see through (several rekeyed to one address, or any rekeyed to another Folks loan app); if a new Folks escrow type shows up, add it to `FOLKS_ESCROW_APPS`.
