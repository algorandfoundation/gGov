import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { generateAccount } from 'algosdk'
import { GGovCommitteeFile, GGovSDK } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import {
  errAccountAqNotExists,
  errAccountNotExists,
  errAqIncomplete,
  errAqNotStarted,
  errGGovCannotOverride,
  errGGovNoDelegation,
  errGGovNotReady,
  errGGovPeriodNotExists,
  errGGovVoteMismatch,
  errGGovVotePowerMismatch,
  errGGovVotingEnded,
} from '../base/errors.algo'
import {
  createSDK,
  deployFracInstance,
  deployRegistry,
  generateAccountWithFracInstanceSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

// E2E only, no unit spec: vote() inner-calls the frac registry's getAccount and the gGov period's
// vote(), which algorand-typescript-testing 1.1.0 cannot exercise (see the note in
// fracDelegationInstance.algoquarters.e2e.spec.ts).

/**
 * Create a period on `ggovSdk`, add `topicOptionsList` as topics, pull the voting window into the
 * present and mark it ready. Mirrors fracDelegationInstance.periods.e2e.spec.ts.
 */
const createReadyPeriod = async (ggovSdk: GGovSDK, committeeId: Uint8Array, topicOptionsList: string[][]) => {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const periodId = await ggovSdk.registry.addPeriod({
    committeeId,
    votingStart: now + 10_000n,
    votingEnd: now + 20_000n,
  })
  for (const options of topicOptionsList) {
    await ggovSdk.addTopic({ periodId, options })
  }
  await ggovSdk.editPeriod({ periodId, committeeId, votingStart: now - 600n, votingEnd: now + 3600n })
  await ggovSdk.setReady({ periodId, ready: true })
  return periodId
}

/**
 * The full voting fixture: a gGov committee whose members are the instance's escrows (with the
 * given per-escrow powers), every escrow delegated to the instance app account, a ready + synced
 * period shaped to `topics` (last option of each topic is Abstain by convention), and an open AQ
 * ledger of `totalAq`. Tests ingest their own voters — the ledger must reach exactly `totalAq`
 * before `vote` passes its completeness gate.
 */
const setupVoting = async (
  localnet: AlgorandFixture,
  {
    powers = [15, 15, 20],
    totalAq = 100,
    topics = [['A', 'B', 'Abstain']],
    startIngest = true,
    delegate = true,
    powerlessFirstEscrow = false,
  } = {},
) => {
  const { testAccount } = localnet.context
  // Escrows are gGov committee members with individual voting power, and they sign (delegation,
  // and the direct-vote rejection test), so they need funded LocalNet accounts.
  const escrowAccounts = await Promise.all(
    powers.map(() => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const { sdk: ggovRegistrySdk } = await deployRegistry(localnet, testAccount)
  const committeeId = await ggovRegistrySdk.uploadCommitteeFile({
    ...committeeTemplate,
    totalMembers: powers.length,
    totalVotes: powers.reduce((a, b) => a + b, 0),
    registryId: 0,
    govs: escrowAccounts.map((a, i) => ({ address: a.toString(), votes: powers[i] })),
  } as GGovCommitteeFile)
  const ggovSdk = new GGovSDK({
    algorand: localnet.algorand,
    registryAppId: ggovRegistrySdk.appId,
    writerAccount: { sender: testAccount, signer: localnet.algorand.account.getSigner(testAccount) },
  })
  await ggovSdk.registry.setOperator({ account: testAccount.toString() })

  const { registrySdk, sdk: instanceSdk, instanceId } = await deployFracInstance(localnet, testAccount)
  await registrySdk.setGGovRegistryApp({ appId: ggovRegistrySdk.appId })
  // A powerless escrow is one that is not a committee member: it snapshots 0 votes. Registered
  // first so the greedy spread has to step over it at index 0, not just past the end.
  if (powerlessFirstEscrow) {
    const outsider = await localnet.context.generateAccount({ initialFunds: (1).algos() })
    await registrySdk.registerEscrow({ instanceNumId: instanceId, account: outsider.toString() })
  }
  for (const account of escrowAccounts) {
    await registrySdk.registerEscrow({ instanceNumId: instanceId, account: account.toString() })
  }
  await instanceSdk.syncCommittee({ committeeId })

  // The instance pays votingRecords + periodEscrowVotes box MBR; the frac registry pays per-account
  // MBR when ingestAq first sees a voter. No funding path between them, so top up both.
  const instanceAppAddress = instanceSdk.readClient.appAddress.toString()
  await localnet.algorand.account.ensureFundedFromEnvironment(instanceAppAddress, (10).algos())
  await localnet.algorand.account.ensureFundedFromEnvironment(registrySdk.readClient.appAddress, (5).algos())

  // Every escrow delegates its gGov voting power to the instance app account — the mechanism that
  // lets the instance's inner vote() calls pass the period's delegation check.
  if (delegate) {
    for (const escrow of escrowAccounts) {
      await createSDK(localnet, ggovRegistrySdk.appId, escrow).setVotingAccount({ votingAddress: instanceAppAddress })
    }
  }

  const periodId = await createReadyPeriod(ggovSdk, committeeId, topics)
  const periodAppId = await ggovSdk.getPeriodAppId(periodId)
  await instanceSdk.syncPeriod({ periodApp: periodAppId })
  const committeeNumId = (await instanceSdk.getCommittee(committeeId))!.committeeNumId
  if (startIngest) {
    await instanceSdk.startAqIngest({ committeeId, totalAq })
  }

  return {
    testAccount,
    ggovSdk,
    ggovRegistrySdk,
    committeeId,
    committeeNumId,
    escrowAccounts,
    registrySdk,
    instanceSdk,
    instanceId,
    periodId,
    periodAppId,
    instanceAppAddress,
    totalAq,
  }
}

type VotingCtx = Awaited<ReturnType<typeof setupVoting>>

/** A funded account with `aq` AlgoQuarters ingested, and an instance SDK writing as it. */
const addVoter = async (localnet: AlgorandFixture, ctx: VotingCtx, aq: number) => {
  const { account, sdk } = await generateAccountWithFracInstanceSDK(localnet, ctx.instanceSdk.appId, (2).algos())
  await ctx.instanceSdk.ingestAq({ committeeNumId: ctx.committeeNumId, accountAqs: [[account.toString(), aq]] })
  return { account, sdk }
}

/** Ingest `aq` AlgoQuarters for a fresh address that never votes (and never signs). */
const ingestNonVoter = async (ctx: VotingCtx, aq: number) => {
  await ctx.instanceSdk.ingestAq({
    committeeNumId: ctx.committeeNumId,
    accountAqs: [[generateAccount().addr.toString(), aq]],
  })
}

/** The voter's frac registry numeric account ID. */
const accountIdOf = async (ctx: VotingCtx, address: string) =>
  (await ctx.registrySdk.getAccountIdMap([address])).get(address)!

/** The gGov period's tallies, [topic] -> votes-per-option. */
const ggovTallies = async (ctx: VotingCtx) =>
  (await ctx.ggovSdk.getPeriod(ctx.periodId)).topics.map((topic) => topic[1])

/** Inner txns of the vote app call (the group's last txn): 1 registry resolve + 1 per escrow cast. */
const voteInnerTxnCount = (result: { confirmations?: { innerTxns?: unknown[] }[] }) => {
  const confirmations = result.confirmations!
  return confirmations[confirmations.length - 1].innerTxns?.length ?? 0
}

describe('FracDelegationInstance vote', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('vote', () => {
    test('first vote tallies internally, maps onto escrow power and casts through every escrow', async () => {
      // The worked example from VOTE.md: powers 15/15/20 (T=50), totalAq 100.
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      const cache = (await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!
      expect(cache.internal).toEqual([[50, 30, 20]])
      expect(cache.ggovTotals).toEqual([[25, 15, 10]])

      // Greedy spread: options consume escrow capacity in escrow order, every row sums to power.
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 0))!.votes).toEqual([[15, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 1))!.votes).toEqual([[10, 5, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 2))!.votes).toEqual([[0, 10, 10]])

      // The gGov period agrees with the cached totals.
      expect(await ggovTallies(ctx)).toEqual([[25, 15, 10]])

      // The record stores exactly what was submitted; 4 inners = 1 registry resolve + 3 casts.
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[50, 30, 20]])
      expect(voteInnerTxnCount(result)).toBe(4)
    })

    test('AQ that never votes implicitly counts for the last option', async () => {
      const ctx = await setupVoting(localnet, { totalAq: 1000 })
      await ingestNonVoter(ctx, 900)
      const voter = await addVoter(localnet, ctx, 100)

      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })

      // floor(100 * 50 / 1000) = 5 to A; the 900 unvoted AQ and the voter's zero rows all land on
      // Abstain: 50 - 5 = 45.
      expect(await ggovTallies(ctx)).toEqual([[5, 0, 45]])
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.ggovTotals).toEqual([[5, 0, 45]])
    })

    test('rounding dust lands on the last option', async () => {
      const ctx = await setupVoting(localnet, { totalAq: 3 })
      const voter = await addVoter(localnet, ctx, 3)

      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[1, 1, 1]] })

      // floor(1 * 50 / 3) = 16 per non-abstain option; Abstain takes 50 - 32 = 18 (16 mapped + 2 dust).
      expect(await ggovTallies(ctx)).toEqual([[16, 16, 18]])
    })

    test('votes from multiple accounts accumulate', async () => {
      const ctx = await setupVoting(localnet)
      const [v1, v2] = [await addVoter(localnet, ctx, 60), await addVoter(localnet, ctx, 40)]

      await v1.sdk.vote({ periodId: ctx.periodId, topicVotes: [[60, 0, 0]] })
      await v2.sdk.vote({ periodId: ctx.periodId, topicVotes: [[0, 40, 0]] })

      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[60, 40, 0]])
      expect(await ggovTallies(ctx)).toEqual([[30, 20, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 0))!.votes).toEqual([[15, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 1))!.votes).toEqual([[15, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 2))!.votes).toEqual([[0, 20, 0]])
    })

    test('re-vote overwrites: old rows subtracted, escrows re-cast to the new target', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[60, 20, 20]] })
      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[0, 0, 100]] })

      const cache = (await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!
      expect(cache.internal).toEqual([[0, 0, 100]])
      expect(cache.ggovTotals).toEqual([[0, 0, 50]])
      expect(await ggovTallies(ctx)).toEqual([[0, 0, 50]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 0))!.votes).toEqual([[0, 0, 15]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 2))!.votes).toEqual([[0, 0, 20]])
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[0, 0, 100]])
    })

    test('a re-vote that does not move the mapping casts nothing external', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      const first = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })
      const repeat = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      // First vote: registry resolve + 3 escrow casts. Identical re-vote: registry resolve only.
      expect(voteInnerTxnCount(first)).toBe(4)
      expect(voteInnerTxnCount(repeat)).toBe(1)
      expect(await ggovTallies(ctx)).toEqual([[25, 15, 10]])
    })

    test('validates and maps per topic across differing option counts', async () => {
      const ctx = await setupVoting(localnet, {
        topics: [
          ['Yes', 'No', 'Abstain'],
          ['A', 'B', 'C', 'Abstain'],
        ],
      })
      const voter = await addVoter(localnet, ctx, 100)

      await voter.sdk.vote({
        periodId: ctx.periodId,
        topicVotes: [
          [100, 0, 0],
          [25, 25, 25, 25],
        ],
      })

      // T = 50 per topic: [floor(100*50/100), 0, rest] and [12, 12, 12, 50-36=14].
      expect(await ggovTallies(ctx)).toEqual([
        [50, 0, 0],
        [12, 12, 12, 14],
      ])
      // gGov's own sum==power rule proved every escrow row sums to its power on every topic; spot
      // the greedy seams anyway.
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 0))!.votes).toEqual([
        [15, 0, 0],
        [12, 3, 0, 0],
      ])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 2))!.votes).toEqual([
        [20, 0, 0],
        [0, 0, 6, 14],
      ])
    })

    test('steps over a powerless escrow without casting for it', async () => {
      const ctx = await setupVoting(localnet, { powerlessFirstEscrow: true })
      const voter = await addVoter(localnet, ctx, 100)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      // Index 0 is the non-member escrow: zero snapshot power, zero rows, no cast (3 casts, not 4).
      expect(voteInnerTxnCount(result)).toBe(4)
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 0))!.votes).toEqual([[0, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, 1))!.votes).toEqual([[15, 0, 0]])
      expect(await ggovTallies(ctx)).toEqual([[25, 15, 10]])
    })

    test('casts through an escrow count that outgrows one txn of references', async () => {
      // 8 escrows x 3 inner calls each + the registry resolve = 25 inner txns, and ~48 reference
      // slots — both past what a bare app call carries, so makeVoteTxns' padding is load-bearing.
      const powers = Array.from({ length: 8 }, () => 10)
      const ctx = await setupVoting(localnet, { powers, totalAq: 80 })
      const voter = await addVoter(localnet, ctx, 80)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[80, 0, 0]] })

      expect(voteInnerTxnCount(result)).toBe(9)
      expect(await ggovTallies(ctx)).toEqual([[80, 0, 0]])
      for (let i = 0; i < 8; i++) {
        expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, i))!.votes).toEqual([[10, 0, 0]])
      }
    })
  })

  describe('vote rejections', () => {
    test('a topic row that does not sum to the voter AQ', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 19]] })).rejects.toThrow(
        transformedError(errGGovVotePowerMismatch),
      )
    })

    test('topic and option count mismatches', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      // One topic, two rows.
      await expect(
        voter.sdk.vote({
          periodId: ctx.periodId,
          topicVotes: [
            [50, 30, 20],
            [100, 0, 0],
          ],
        }),
      ).rejects.toThrow(transformedError(errGGovVoteMismatch))
      // Three options, two entries.
      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[70, 30]] })).rejects.toThrow(
        transformedError(errGGovVoteMismatch),
      )
    })

    test('a sender the frac registry has never seen', async () => {
      const ctx = await setupVoting(localnet)
      await ingestNonVoter(ctx, 100) // completes the ledger so the gate before account resolution passes
      const { sdk: strangerSdk } = await generateAccountWithFracInstanceSDK(
        localnet,
        ctx.instanceSdk.appId,
        (2).algos(),
      )

      await expect(strangerSdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
    })

    test('a registered account with no AQ in this committee', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      // Uningest the voter (their registry account outlives the AQ box), then refill the ledger so
      // it is complete again — the failure has to be the missing accountAq box, not incompleteness.
      await ctx.instanceSdk.uningestAq({ committeeNumId: ctx.committeeNumId, accounts: [voter.account.toString()] })
      await ingestNonVoter(ctx, 100)

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errAccountAqNotExists),
      )
    })

    test('an AQ ledger that was never opened', async () => {
      const ctx = await setupVoting(localnet, { startIngest: false })
      const { sdk: voterSdk } = await generateAccountWithFracInstanceSDK(localnet, ctx.instanceSdk.appId, (2).algos())

      await expect(voterSdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errAqNotStarted),
      )
    })

    test('an incomplete AQ ledger', async () => {
      const ctx = await setupVoting(localnet, { totalAq: 100 })
      const voter = await addVoter(localnet, ctx, 40)

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[40, 0, 0]] })).rejects.toThrow(
        transformedError(errAqIncomplete),
      )
    })

    test('a period that was never synced', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      await expect(voter.sdk.vote({ periodId: 999, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errGGovPeriodNotExists),
      )
    })

    test('ready and the voting window are read live, not from the stale snapshot', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)

      // Nothing has been cast into gGov yet, so its operator can still un-ready and edit the
      // window. The frac snapshot still says ready and open — the live reads must not.
      await ctx.ggovSdk.setReady({ periodId: ctx.periodId, ready: false })
      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errGGovNotReady),
      )

      const now = BigInt(Math.floor(Date.now() / 1000))
      await ctx.ggovSdk.editPeriod({
        periodId: ctx.periodId,
        committeeId: ctx.committeeId,
        votingStart: now - 5000n,
        votingEnd: now - 600n,
      })
      // Distinct note: this setReady(true) is otherwise byte-identical to the fixture's and would
      // be rejected as already-in-ledger.
      await ctx.ggovSdk.setReady({ periodId: ctx.periodId, ready: true, note: 're-ready after edit' })
      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })).rejects.toThrow(
        transformedError(errGGovVotingEnded),
      )
    })

    test('an escrow that has not delegated to the instance fails the whole vote', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      // Escrow 1 clears its delegation ("vote for self").
      await createSDK(localnet, ctx.ggovRegistrySdk.appId, ctx.escrowAccounts[1]).setVotingAccount({})

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })).rejects.toThrow(
        transformedError(errGGovNoDelegation),
      )
      // Atomic: nothing landed, in gGov or locally.
      expect(await ggovTallies(ctx)).toEqual([[0, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[0, 0, 0]])
    })

    test('an escrow that voted directly can never be overridden', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      // Escrow 2 (power 20) votes for itself directly in gGov.
      const escrow = ctx.escrowAccounts[2]
      const escrowGGovSdk = new GGovSDK({
        algorand: localnet.algorand,
        registryAppId: ctx.ggovRegistrySdk.appId,
        writerAccount: { sender: escrow, signer: localnet.algorand.account.getSigner(escrow) },
      })
      await escrowGGovSdk.vote({ periodId: ctx.periodId, voterAccount: escrow.toString(), topicVotes: [[20, 0, 0]] })

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })).rejects.toThrow(
        transformedError(errGGovCannotOverride),
      )
    })
  })
})
