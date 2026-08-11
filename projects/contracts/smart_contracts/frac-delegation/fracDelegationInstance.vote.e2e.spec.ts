import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { Address, generateAccount, getApplicationAddress } from 'algosdk'
import { FracDelegationInstanceClient, FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovCommitteeFile, GGovSDK } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import {
  errAccountAqNotExists,
  errAccountNotExists,
  errAqIncomplete,
  errAqNotStarted,
  errGGovCannotOverride,
  errGGovDelegationNoAcctRef,
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
  generateAccountWithFracSDK,
  transformedError,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

// The primary coverage for vote(): everything past its first gate inner-calls the frac registry's
// getAccount and the gGov period's vote(), which algorand-typescript-testing 1.1.0 cannot exercise.
// The one unit-reachable gate plus the unit-test plan live in fracDelegationInstance.vote.algo.spec.ts.

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
 * ledger of `totalAq`/`totalAccounts`. Tests ingest their own voters — the ledger must reach both
 * exactly (`ingestedAq === totalAq` AND `numAccounts === totalAccounts`) before `vote` passes its
 * completeness gate, so `totalAccounts` must match the account count each test ingests (default 1).
 */
const setupVoting = async (
  localnet: AlgorandFixture,
  {
    powers = [15, 15, 20],
    totalAq = 100,
    totalAccounts = 1,
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

  const { appId: instanceAppId, instanceId, sdk } = await deployFracInstance(localnet, testAccount)
  const registrySdk = sdk.registry
  await registrySdk.setGGovRegistryApp({ appId: ggovRegistrySdk.appId })
  // The reverse pointer: it lets the gGov registry accept a frac-only account (an AQ holder with no
  // gGov committee membership) as a delegator in set_voting_account, which is what makes user
  // delegation available to frac voters at all.
  await ggovSdk.registry.setFracRegistryApp({ appId: registrySdk.appId })
  // A powerless escrow is one that is not a committee member: it snapshots 0 votes. Registered
  // first so the greedy spread has to step over it at index 0, not just past the end.
  if (powerlessFirstEscrow) {
    const outsider = await localnet.context.generateAccount({ initialFunds: (1).algos() })
    await registrySdk.registerEscrow({ instanceNumId: instanceId, account: outsider.toString() })
  }
  for (const account of escrowAccounts) {
    await registrySdk.registerEscrow({ instanceNumId: instanceId, account: account.toString() })
  }
  await sdk.syncCommittee({ instanceNumId: instanceId, committeeId })

  // The instance pays votingRecords + periodEscrowVotes box MBR; the frac registry pays per-account
  // MBR when ingestAq first sees a voter. No funding path between them, so top up both.
  const instanceAppAddress = getApplicationAddress(instanceAppId).toString()
  const registryAppAddress = sdk.registryReadClient.appAddress.toString()
  await localnet.algorand.account.ensureFundedFromEnvironment(instanceAppAddress, (10).algos())
  await localnet.algorand.account.ensureFundedFromEnvironment(registryAppAddress, (5).algos())

  // Every escrow delegates its gGov voting power to the instance app account — the mechanism that
  // lets the instance's inner vote() calls pass the period's delegation check.
  if (delegate) {
    for (const escrow of escrowAccounts) {
      await createSDK(localnet, ggovRegistrySdk.appId, escrow).setVotingAccount({ votingAddress: instanceAppAddress })
    }
  }

  const periodId = await createReadyPeriod(ggovSdk, committeeId, topics)
  const periodAppId = await ggovSdk.getPeriodAppId(periodId)
  await sdk.syncPeriod({ instanceNumId: instanceId, periodApp: periodAppId })
  const committeeNumId = (await sdk.getCommittee(instanceId, committeeId))!.committeeNumId
  if (startIngest) {
    await sdk.startAqIngest({ instanceNumId: instanceId, committeeId, totalAq, totalAccounts })
  }

  // The combined FracDelegationSDK addresses many instances by `instanceNumId`; like the
  // AlgoQuarters spec, this one makes enough instance calls that we bind the fixture's instance
  // into a single-instance facade so the test bodies read as plain per-instance calls.
  const instanceSdk = {
    ingestAq: (args: { committeeNumId: number; accountAqs: [string, number][]; note?: string }) =>
      sdk.ingestAq({ instanceNumId: instanceId, ...args }),
    uningestAq: (args: { committeeNumId: number; accounts: string[]; note?: string }) =>
      sdk.uningestAq({ instanceNumId: instanceId, ...args }),
    getPeriodVoteCache: (periodId: bigint | number) => sdk.getPeriodVoteCache(instanceId, periodId),
    getPeriodEscrowVotes: (periodId: bigint | number, escrowIndex: bigint | number) =>
      sdk.getPeriodEscrowVotes(instanceId, periodId, escrowIndex),
    getVotingRecord: (periodId: bigint | number, accountId: bigint | number) =>
      sdk.getVotingRecord(instanceId, periodId, accountId),
    canVote: (periodId: bigint | number, voterAccount: string, senderAccount?: string) =>
      sdk.canVote(instanceId, periodId, voterAccount, senderAccount),
  }

  return {
    testAccount,
    ggovSdk,
    ggovRegistrySdk,
    committeeId,
    committeeNumId,
    escrowAccounts,
    registrySdk,
    sdk,
    instanceSdk,
    instanceId,
    periodId,
    periodAppId,
    instanceAppAddress,
    registryAppAddress,
    totalAq,
  }
}

type VotingCtx = Awaited<ReturnType<typeof setupVoting>>

/** The end-user voting surface of a combined SDK, bound to the fixture's instance. */
const bindVote = (sdk: FracDelegationSDK, instanceNumId: bigint | number) => ({
  vote: (args: Omit<Parameters<FracDelegationSDK['vote']>[0], 'instanceNumId'>) => sdk.vote({ instanceNumId, ...args }),
})

/** A funded account with `aq` AlgoQuarters ingested, and a vote() signing as it. */
const addVoter = async (localnet: AlgorandFixture, ctx: VotingCtx, aq: number) => {
  const { account, sdk } = await generateAccountWithFracSDK(localnet, ctx.sdk.appId, (2).algos())
  await ctx.instanceSdk.ingestAq({ committeeNumId: ctx.committeeNumId, accountAqs: [[account.toString(), aq]] })
  return { account, sdk: bindVote(sdk, ctx.instanceId) }
}

/** A funded account with a vote() signing as it, but no AlgoQuarters of its own — a pure delegatee. */
const addDelegatee = async (localnet: AlgorandFixture, ctx: VotingCtx) => {
  const { account, sdk } = await generateAccountWithFracSDK(localnet, ctx.sdk.appId, (2).algos())
  return { account, sdk: bindVote(sdk, ctx.instanceId) }
}

/**
 * Point `delegator` at `delegatee` on the gGov registry — the single source of truth for gGov and
 * frac delegations alike. `delegator` here is a frac-only account (AQ holder, no gGov committee
 * membership), so this also exercises the gGov registry's frac-registry fallback — hence
 * `fractionalOnly`, which pays for that fallback's inner call.
 */
const delegateTo = (localnet: AlgorandFixture, ctx: VotingCtx, delegator: Address, delegatee: Address) =>
  createSDK(localnet, ctx.ggovRegistrySdk.appId, delegator).setVotingAccount({
    votingAddress: delegatee.toString(),
    fractionalOnly: true,
  })

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

/** The instance app account's available balance. */
const instanceAvailable = async (localnet: AlgorandFixture, ctx: VotingCtx) => {
  const info = await localnet.algorand.account.getInformation(ctx.instanceAppAddress)
  return info.balance.microAlgo - info.minBalance.microAlgo
}

/** The registry app account's available balance. */
const registryAvailable = async (localnet: AlgorandFixture, ctx: VotingCtx) => {
  const info = await localnet.algorand.account.getInformation(ctx.registryAppAddress)
  return info.balance.microAlgo - info.minBalance.microAlgo
}

/** Withdraw the instance's available balance down to `leave` microALGO. */
const drainInstanceTo = async (localnet: AlgorandFixture, ctx: VotingCtx, leave: bigint) => {
  const available = await instanceAvailable(localnet, ctx)
  await ctx.sdk.withdrawInstanceALGO({
    instanceNumId: ctx.instanceId,
    receiver: ctx.testAccount.toString(),
    amount: available - leave,
  })
  expect(await instanceAvailable(localnet, ctx)).toBe(leave)
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
      const ctx = await setupVoting(localnet, { totalAq: 1000, totalAccounts: 2 })
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
      const ctx = await setupVoting(localnet, { totalAccounts: 2 })
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

    test('casts across the production maximum of six escrows with uneven powers', async () => {
      // Six escrows is the most an instance will run in production; uneven powers make the greedy
      // spread land mid-escrow on both option seams, unlike the uniform 8-escrow scale test below.
      const powers = [10, 20, 5, 25, 15, 25] // T = 100
      const ctx = await setupVoting(localnet, { powers, totalAq: 60 })
      const voter = await addVoter(localnet, ctx, 60)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[25, 15, 20]] })

      // floor(25*100/60) = 41, floor(15*100/60) = 25, Abstain takes 100 - 66 = 34.
      expect(await ggovTallies(ctx)).toEqual([[41, 25, 34]])
      expect(voteInnerTxnCount(result)).toBe(7)
      const rows = [[[10, 0, 0]], [[20, 0, 0]], [[5, 0, 0]], [[6, 19, 0]], [[0, 6, 9]], [[0, 0, 25]]]
      for (const [i, votes] of rows.entries()) {
        expect((await ctx.instanceSdk.getPeriodEscrowVotes(ctx.periodId, i))!.votes).toEqual(votes)
      }
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
      const { sdk: strangerRawSdk } = await generateAccountWithFracSDK(localnet, ctx.sdk.appId, (2).algos())
      const strangerSdk = bindVote(strangerRawSdk, ctx.instanceId)

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
      const { sdk: rawSdk } = await generateAccountWithFracSDK(localnet, ctx.sdk.appId, (2).algos())
      const voterSdk = bindVote(rawSdk, ctx.instanceId)

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

  // User (voter -> delegatee) delegation, mirroring GGovPeriod.vote's model and reading the same
  // source of truth: the gGov registry's `delegations` box. Distinct from the escrow -> instance
  // delegation the fixture always sets up, which is what lets the instance cast externally.
  describe('user delegation', () => {
    test('a delegatee casts the delegator internal vote', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      const result = await delegatee.sdk.vote({
        periodId: ctx.periodId,
        voterAccount: voter.account.toString(),
        topicVotes: [[50, 30, 20]],
      })

      // Tallied against the delegator's AQ weight, exactly as if they had voted themselves.
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[50, 30, 20]])
      expect(await ggovTallies(ctx)).toEqual([[25, 15, 10]])

      // The record is keyed by the delegator's account ID and flagged as delegated.
      const accountId = await accountIdOf(ctx, voter.account.toString())
      const record = (await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!
      expect(record.isDelegated).toBe(true)
      expect(record.topicVotes).toEqual([[50, 30, 20]])
      // Voting for someone else does not make the delegatee a frac account (0 = unregistered), so it
      // has no AQ ledger entry and no record of its own.
      expect(await accountIdOf(ctx, delegatee.account.toString())).toBe(0)

      // 5 inners = gGov getDelegate + frac registry getAccount + 3 escrow casts.
      expect(voteInnerTxnCount(result)).toBe(5)
    })

    test('a delegatee cannot override a vote the owner cast directly', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[100, 0, 0]] })
      await expect(
        delegatee.sdk.vote({
          periodId: ctx.periodId,
          voterAccount: voter.account.toString(),
          topicVotes: [[0, 0, 100]],
        }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))

      // Rejected before anything was mutated: tally, record and gGov tallies all still the direct vote.
      const accountId = await accountIdOf(ctx, voter.account.toString())
      const record = (await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!
      expect(record.isDelegated).toBe(false)
      expect(record.topicVotes).toEqual([[100, 0, 0]])
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[100, 0, 0]])
      expect(await ggovTallies(ctx)).toEqual([[50, 0, 0]])
    })

    test('the owner can always override a delegated vote', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      await delegatee.sdk.vote({
        periodId: ctx.periodId,
        voterAccount: voter.account.toString(),
        topicVotes: [[100, 0, 0]],
      })
      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[0, 0, 100]] })

      const accountId = await accountIdOf(ctx, voter.account.toString())
      const record = (await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!
      expect(record.isDelegated).toBe(false) // flips back, and locks the delegatee out from here on
      expect(record.topicVotes).toEqual([[0, 0, 100]])
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[0, 0, 100]])
      expect(await ggovTallies(ctx)).toEqual([[0, 0, 50]])

      await expect(
        delegatee.sdk.vote({
          periodId: ctx.periodId,
          voterAccount: voter.account.toString(),
          topicVotes: [[100, 0, 0]],
        }),
      ).rejects.toThrow(transformedError(errGGovCannotOverride))
    })

    test('a delegatee can override its own earlier delegated vote', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      const voteAs = (topicVotes: number[][]) =>
        delegatee.sdk.vote({ periodId: ctx.periodId, voterAccount: voter.account.toString(), topicVotes })
      await voteAs([[100, 0, 0]])
      await voteAs([[0, 100, 0]])

      const accountId = await accountIdOf(ctx, voter.account.toString())
      const record = (await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!
      expect(record.isDelegated).toBe(true)
      expect(record.topicVotes).toEqual([[0, 100, 0]])
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[0, 100, 0]])
      expect(await ggovTallies(ctx)).toEqual([[0, 50, 0]])
    })

    test('a sender the voter has not delegated to is rejected', async () => {
      const ctx = await setupVoting(localnet, { totalAccounts: 2 })
      const voter = await addVoter(localnet, ctx, 60)
      const otherVoter = await addVoter(localnet, ctx, 40)
      const stranger = await addDelegatee(localnet, ctx)
      const strangerVotesVoter = () =>
        stranger.sdk.vote({
          periodId: ctx.periodId,
          voterAccount: voter.account.toString(),
          topicVotes: [[60, 0, 0]],
        })

      // No delegation at all.
      await expect(strangerVotesVoter()).rejects.toThrow(transformedError(errGGovNoDelegation))

      // Delegated, but from somebody else.
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)
      await expect(strangerVotesVoter()).rejects.toThrow(transformedError(errGGovNoDelegation))

      // Holding a delegation is not a licence to vote for anyone: the stranger is now somebody's
      // delegatee, but the gate matches getDelegate(voterAccount) against the sender, so a
      // delegation received from `otherVoter` buys nothing against `voter`.
      await delegateTo(localnet, ctx, otherVoter.account, stranger.account)
      await expect(strangerVotesVoter()).rejects.toThrow(transformedError(errGGovNoDelegation))
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[0, 0, 0]])

      // ...and that delegation really is live, so the rejections above are about the delegator, not
      // a fixture that failed to delegate: the same sender casts `otherVoter`'s weight fine.
      await stranger.sdk.vote({
        periodId: ctx.periodId,
        voterAccount: otherVoter.account.toString(),
        topicVotes: [[0, 40, 0]],
      })
      expect((await ctx.instanceSdk.getPeriodVoteCache(ctx.periodId))!.internal).toEqual([[0, 40, 0]])
    })

    test('a delegated vote without the delegator account reference is rejected', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      // Call the instance client directly so we can omit the account reference the SDK adds for
      // delegated votes. The contract must reject it (Txn.accounts(1) !== the delegator).
      const rawClient = new FracDelegationInstanceClient({
        algorand: localnet.algorand,
        appId: await ctx.sdk.getInstanceAppId(ctx.instanceId),
        defaultSender: delegatee.account.toString(),
        defaultSigner: localnet.algorand.account.getSigner(delegatee.account),
      })
      await expect(
        rawClient.send.vote({
          args: { voterAccount: voter.account.toString(), periodId: ctx.periodId, topicVotes: [[100, 0, 0]] },
          extraFee: (5000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errGGovDelegationNoAcctRef))
    })

    test('the registry-side record readers carry the delegated flag through', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)

      await delegatee.sdk.vote({
        periodId: ctx.periodId,
        voterAccount: voter.account.toString(),
        topicVotes: [[50, 30, 20]],
      })

      const expected = {
        instanceNumId: Number(ctx.instanceId),
        instanceAppId: await ctx.sdk.getInstanceAppId(ctx.instanceId),
        instanceName: (await ctx.registrySdk.getInstance(ctx.instanceId))!.name,
        isDelegated: true,
        topicVotes: [[50, 30, 20]],
      }
      const voterAddress = voter.account.toString()
      expect(await ctx.registrySdk.getAccountVotingRecord(voterAddress, ctx.instanceId, ctx.periodId)).toEqual(expected)
      expect(await ctx.registrySdk.getAccountVotingRecords(voterAddress, ctx.periodId)).toEqual([expected])
    }, 120_000)

    test('canVote mirrors the delegated gates, including the override guard', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      const voterAddress = voter.account.toString()
      const delegateeAddress = delegatee.account.toString()

      // Self-vote is fine; the delegatee is not yet authorised, and has no AQ of its own either.
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress)).toEqual([true, 100n])
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress, delegateeAddress)).toEqual([false, 0n])
      expect(await ctx.instanceSdk.canVote(ctx.periodId, delegateeAddress)).toEqual([false, 0n])

      await delegateTo(localnet, ctx, voter.account, delegatee.account)
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress, delegateeAddress)).toEqual([true, 100n])

      // A delegated vote leaves the delegatee eligible; a direct one locks it out, exactly as vote()
      // enforces.
      await delegatee.sdk.vote({ periodId: ctx.periodId, voterAccount: voterAddress, topicVotes: [[100, 0, 0]] })
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress, delegateeAddress)).toEqual([true, 100n])
      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[0, 100, 0]] })
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress, delegateeAddress)).toEqual([false, 0n])
      expect(await ctx.instanceSdk.canVote(ctx.periodId, voterAddress)).toEqual([true, 100n])

      // An unsynced period is never votable.
      expect(await ctx.instanceSdk.canVote(999, voterAddress)).toEqual([false, 0n])
    })
  })

  // The reader/algoquarters specs cover these getters only against empty topicVotes; here a real vote
  // is cast so the nested Uint32[][] payload is exercised end-to-end
  describe('cross-instance voting record readers', () => {
    test('read back a cast vote, non-empty topicVotes, singular and plural paths agree', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      const expected = {
        instanceNumId: Number(ctx.instanceId),
        instanceAppId: await ctx.sdk.getInstanceAppId(ctx.instanceId),
        instanceName: (await ctx.registrySdk.getInstance(ctx.instanceId))!.name,
        isDelegated: false, // cast by the owner, not a delegatee
        topicVotes: [[50, 30, 20]], // exactly what was submitted, decoded via the generated struct
      }

      expect(
        await ctx.registrySdk.getAccountVotingRecord(voter.account.toString(), ctx.instanceId, ctx.periodId),
      ).toEqual(expected)
      expect(await ctx.registrySdk.getAccountVotingRecords(voter.account.toString(), ctx.periodId)).toEqual([expected])
    }, 120_000)
  })

  describe('MBR self-funding via registry vault', () => {
    // Acts as well as regression test for the AVM property the whole design rests on: that `box_create`
    // raises `min_balance` immediately but defers the balance check to the end of the outer transaction.

    // One topic of three options: S = 1 + 3, so the record is 5 + 4*S = 21 bytes over a 9-byte key
    // ('r' + FracPeriodAccountKey), and box MBR is 2500 + 400 * (key + value).
    const VOTE_RECORD_MBR = 2_500n + 400n * (9n + 21n)
    const MBR_TOP_UP = 5_000_000n
    const REQUEST_FEE = 1_000n

    test('a well-funded instance never asks for a top-up', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const registryAvailableBefore = await registryAvailable(localnet, ctx)
      const instanceAvailableBefore = await instanceAvailable(localnet, ctx)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      expect(voteInnerTxnCount(result)).toBe(4)
      expect(await registryAvailable(localnet, ctx)).toBe(registryAvailableBefore)
      expect(await instanceAvailable(localnet, ctx)).toBe(instanceAvailableBefore - VOTE_RECORD_MBR)
    }, 120_000)

    test('an instance with not enough available balance requests an MBR top-up', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const leftover = VOTE_RECORD_MBR / 3n // positive, well under the record's MBR
      await drainInstanceTo(localnet, ctx, leftover)
      const registryAvailableBefore = await registryAvailable(localnet, ctx)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      expect(voteInnerTxnCount(result)).toBe(5)
      expect(await registryAvailable(localnet, ctx)).toBe(registryAvailableBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await instanceAvailable(localnet, ctx)).toBe(leftover + MBR_TOP_UP - REQUEST_FEE - VOTE_RECORD_MBR)
      // Record is successfully stored
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[50, 30, 20]])
    }, 120_000)

    test('an instance at zero available balance requests an MBR top-up', async () => {
      // This is the `balance === minBalance` case
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      await drainInstanceTo(localnet, ctx, VOTE_RECORD_MBR)
      const registryAvailableBefore = await registryAvailable(localnet, ctx)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })

      expect(voteInnerTxnCount(result)).toBe(5)
      expect(await registryAvailable(localnet, ctx)).toBe(registryAvailableBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await instanceAvailable(localnet, ctx)).toBe(MBR_TOP_UP - REQUEST_FEE)
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[50, 30, 20]])
    }, 120_000)

    test('a delegated vote requests an MBR top-up too', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      const delegatee = await addDelegatee(localnet, ctx)
      await delegateTo(localnet, ctx, voter.account, delegatee.account)
      const leftover = VOTE_RECORD_MBR / 3n
      await drainInstanceTo(localnet, ctx, leftover)
      const registryAvailableBefore = await registryAvailable(localnet, ctx)

      const result = await delegatee.sdk.vote({
        periodId: ctx.periodId,
        voterAccount: voter.account.toString(),
        topicVotes: [[50, 30, 20]],
      })

      // 6 = the delegated path's 5 (gGov getDelegate + registry getAccount + 3 escrow casts) + requestMBR.
      expect(voteInnerTxnCount(result)).toBe(6)
      expect(await registryAvailable(localnet, ctx)).toBe(registryAvailableBefore - MBR_TOP_UP - REQUEST_FEE)
      expect(await instanceAvailable(localnet, ctx)).toBe(leftover + MBR_TOP_UP - REQUEST_FEE - VOTE_RECORD_MBR)
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[50, 30, 20]])
    }, 120_000)

    test('a re-vote costs no MBR: one microALGO of headroom carries it', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })
      await drainInstanceTo(localnet, ctx, 1n)

      const result = await voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[20, 30, 50]] })

      expect(voteInnerTxnCount(result)).toBe(4)
      expect(await instanceAvailable(localnet, ctx)).toBe(1n)
      const accountId = await accountIdOf(ctx, voter.account.toString())
      expect((await ctx.instanceSdk.getVotingRecord(ctx.periodId, accountId))!.topicVotes).toEqual([[20, 30, 50]])
    }, 120_000)

    test('a drained registry fails the user-facing vote call', async () => {
      const ctx = await setupVoting(localnet)
      const voter = await addVoter(localnet, ctx, 100)
      await drainInstanceTo(localnet, ctx, 3n)
      await ctx.registrySdk.withdrawALGO({
        receiver: ctx.testAccount.toString(),
        amount: await registryAvailable(localnet, ctx),
      })

      await expect(voter.sdk.vote({ periodId: ctx.periodId, topicVotes: [[50, 30, 20]] })).rejects.toThrow()
    }, 120_000)

    test('every vote references the registry app and its instances box, top-up or not', async () => {
      // The vote must name the registry's `instances` box unconditionally: checkNeedMBR reads it only
      // on a branch another voter's transaction can flip between simulate and execution, and resource
      // population resolves references BY simulating. Regression test: nothing else in this suite would
      // notice if the SDK stopped sending it.
      const ctx = await setupVoting(localnet, { totalAccounts: 2 })
      const first = await addVoter(localnet, ctx, 60)
      const second = await addVoter(localnet, ctx, 40)

      const vaultBeforeFirst = await registryAvailable(localnet, ctx)
      const voteNoTopUp = await first.sdk.vote({ periodId: ctx.periodId, topicVotes: [[60, 0, 0]] })
      const vaultAfterFirst = await registryAvailable(localnet, ctx)
      await drainInstanceTo(localnet, ctx, VOTE_RECORD_MBR / 3n)
      const voteWithTopUp = await second.sdk.vote({ periodId: ctx.periodId, topicVotes: [[0, 40, 0]] })

      expect(vaultAfterFirst).toBe(vaultBeforeFirst)
      expect(await registryAvailable(localnet, ctx)).toBe(vaultAfterFirst - MBR_TOP_UP - REQUEST_FEE)

      const registryAppId = ctx.registrySdk.appId
      // 'i' + uint16(instanceNumId), matching BoxMap<Uint16, FracInstance>({ keyPrefix: 'i' }).
      const expectedName = new Uint8Array([
        ...Buffer.from('i'),
        Number(ctx.instanceId) >> 8,
        Number(ctx.instanceId) & 0xff,
      ])
      // The vote app call is the group's last txn; the reference pads come before it.
      const voteCall = (r: typeof voteNoTopUp) => r.transactions[r.transactions.length - 1]

      for (const result of [voteNoTopUp, voteWithTopUp]) {
        const { foreignApps, boxes } = voteCall(result).applicationCall!
        expect(foreignApps).toContain(registryAppId)
        expect(boxes.some((b) => b.appIndex === registryAppId && Buffer.from(b.name).equals(expectedName))).toBe(true)
      }
      // The two MBR inner calls pay their own fees, so the voter pays the same either way.
      expect(voteCall(voteWithTopUp).fee).toBe(voteCall(voteNoTopUp).fee)
    }, 120_000)
  })
})
