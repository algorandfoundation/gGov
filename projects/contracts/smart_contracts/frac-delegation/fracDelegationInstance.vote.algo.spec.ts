import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, it } from 'vitest'
import { expectArc65Error } from '../base/common-tests'
import { errGGovPeriodNotExists } from '../base/errors.algo'
import { u32 } from '../base/utils.algo'
import { FracDelegationInstanceContract } from './fracDelegationInstance.algo'

// `vote()` is covered end-to-end in fracDelegationInstance.vote.e2e.spec.ts. Under the unit
// harness, only its very first gate is reachable: every step past the `periods` box check crosses
// an app boundary — live `op.AppGlobal.getEx*` reads of the period app's globals, an inner
// `getAccount` to the frac registry, and (per re-cast escrow) an inner `GGovPeriod.vote` that
// itself inner-calls the gGov registry. That is a four-app web the unit harness cannot stand up on
// the pinned toolchain (@algorandfoundation/algorand-typescript-testing@1.1.0), and would remain
// the wrong tool for the full flow even on 1.2.0 (see the describe.skip note in
// fracDelegationRegistry.account.algo.spec.ts for the toolchain background).
//
// Note the 1.1.0 clone()-of-reference-type limitation is NOT the blocker here: the frac structs
// were deliberately shaped to dodge it (FracInstancePeriod.periodAppId is a bare uint64), so
// seeding the instance's own boxes works fine. It is the cross-app execution that is out of reach.
//
// The it.todo entries below record the unit-test plan, with the worked scenario from VOTE.md, for
// when the harness can either stub inner ABI calls or the mapping/spread math is extracted into
// protected subroutines (exposed via the declare-public subclass trick the account spec uses) —
// pure functions of (internal tally, escrow powers, totalAq) that need no harness support at all.

describe('[fast] FracDelegationInstanceContract vote', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => ctx.reset())

  describe('gates before any cross-app read', () => {
    it('rejects a period that was never synced', () => {
      const contract = ctx.contract.create(FracDelegationInstanceContract)

      expectArc65Error(ctx, () => contract.vote(ctx.defaultSender, u32(999), []), errGGovPeriodNotExists)
    })
  })

  describe('unit plan — pending inner-call stubbing or math extraction', () => {
    // Common seeding recipe. All instance-side boxes are clone-safe arc4 shapes, so this part
    // already works on 1.1.0 (worked scenario: escrow powers 15/15/20, T = 50, totalAq = 100):
    //
    //   contract.periods(u32(1)).value = {
    //     periodAppId: <foreign app id>, committeeId, committeeNumId: u16(1),
    //     votingStart: u32(...), votingEnd: u32(...), topicOptionLengths: [u32(3)], numEscrows: u8(3),
    //   }
    //   contract.periodVoteCache(u32(1)).value = { internal: [zeros], ggovTotals: [zeros] }
    //   contract.committees(committeeId).value = {
    //     committeeNumId: u16(1), escrowsVotes: [u32(15), u32(15), u32(20)], totalVotes: u32(50),
    //   }
    //   contract.committeeAq(u16(1)).value = { totalAq: u32(100), ingestedAq: u32(100), totalAccounts: u32(1), numAccounts: u32(1) }
    //   contract.accountAq([u32(1), u16(1)]).value = u32(100)
    //   contract.periodEscrowVotes([u32(1), u8(i)]).value = { votes: [zeros] }
    //   contract.escrows.value = [escrow0, escrow1, escrow2]
    //
    // ...plus what the harness cannot provide today: the period app's `ready` / `votingStart` /
    // `votingEnd` / `committeeId` globals readable via op.AppGlobal.getEx* on a foreign app, the
    // frac registry's `getAccount` answered for the voter, the gGov registry's `getDelegate`
    // answered for a delegated vote, and `GGovPeriod.vote` accepting the per-escrow inner casts.

    it.todo(
      'live period gates: ready=0 → ERR:GP_NR; now < votingStart → ERR:GP_NS; now >= votingEnd → ERR:GP_EN; ' +
        'live committeeId != snapshot → ERR:FP_MM (all read off the period app, not the snapshot) [needs foreign-app globals]',
    )
    it.todo(
      'AQ ledger gates: no committeeAq box → ERR:FA_NS; ingestedAq < totalAq → ERR:FA_NC [needs foreign-app globals]',
    )
    it.todo(
      'voter resolution: getAccount → accountId 0 → ERR:A_NX; known account without an accountAq box → ERR:FA_NX ' +
        '[needs getAccount inner-call stub]',
    )
    it.todo(
      'shape and sum validation: wrong topic count / wrong option count → ERR:GV_MM; a topic row not summing to ' +
        'the voter userAq → ERR:GV_VP [needs getAccount inner-call stub]',
    )
    it.todo(
      'delegation: sender != voterAccount and the gGov registry names someone else → ERR:GD_NX; delegation present but ' +
        'the voter is not at Txn.accounts(1) → ERR:GD_NR; both satisfied → the record is written with isDelegated=true ' +
        '[needs a gGov registry getDelegate stub]',
    )
    it.todo(
      'override guard: a delegated re-vote over a record with isDelegated=false → ERR:GV_OD, with the tally and the ' +
        'stored record left untouched; the owner may always overwrite a delegated record (flag flips back to false); ' +
        'a delegatee may overwrite its own delegated record [needs a getDelegate stub]',
    )
    it.todo(
      'canVote mirrors every gate non-throwingly, returning [false, 0] for each rejection above and [true, userAq] ' +
        'otherwise — including the override guard, so it agrees with what vote() enforces',
    )
    it.todo(
      'tally: first vote adds the rows into periodVoteCache.internal and writes votingRecords([periodId, accountId]); ' +
        'a re-vote subtracts the stored rows before adding the new ones (overwrite, not accumulate)',
    )
    it.todo(
      'mapping (pure math — unit-testable today if extracted into a protected subroutine): internal [[50,30,20]] ' +
        'at totalAq 100, T 50 → ggovVotes [[25,15,10]]; non-last options floor(internal·T/totalAq), last option ' +
        'takes T − Σ(others); unvoted AQ lands on the last option ([[100,0,0]] at totalAq 1000 → [[5,0,45]]); ' +
        'rounding dust lands on the last option ([[1,1,1]] at totalAq 3 → [[16,16,18]])',
    )
    it.todo(
      'greedy spread (pure math — same extraction): demands [25,15,10] over powers [15,15,20] → ' +
        '[15,0,0] / [10,5,0] / [0,10,10]; capacities reset per topic so every escrow row sums to its full power; ' +
        'a zero-power escrow owns an empty range and is stepped over',
    )
    it.todo(
      'external cast: only escrows whose spread differs from their periodEscrowVotes box are re-cast; each inner ' +
        'GGovPeriod.vote gets voterAccount = escrow with the escrow in its foreign-accounts array; escrow boxes and ' +
        'periodVoteCache.ggovTotals are updated together; an unchanged mapping casts nothing [needs GGovPeriod stub]',
    )
    it.todo(
      'event: FracVoteCast { voter, sender, accountId, userAq, updateVote, topicVotes } with updateVote=true only on ' +
        're-vote, and voter != sender only on a delegated vote',
    )
  })
})
