/**
 * Opcode-budget guard for the fractional vote path, at the shape that broke it.
 *
 * A frac `vote()` re-casts the instance's whole gGov position through every escrow inside one
 * group, so its opcode cost is roughly `topics x (fixed + escrows x per-escrow)` — the only vote
 * path in the system that multiplies two unbounded axes together. Past a point no amount of opup
 * can pay for it: a group pools 700 opcodes per app call and may carry at most 256 app calls in
 * total, which caps the usable pooled budget at roughly 171,800 once the opup calls' own
 * base/increment costs and the app calls the vote itself already spends come out. Over that, the
 * SDK's budget planner cannot provision the group at all and refuses it up front ("needs N opup
 * inner txns, over the M app calls left in the group").
 *
 * xALGO — 22 topics x 3 options over 6 escrows — went over. Measured on LocalNet with exec traces,
 * that vote burned 213,875 opcodes with the tallies stored as nested `uint32[][]`, against 81,810
 * for the group this test builds: every access to a nested ARC-4 array pays an offset-table lookup
 * plus a row decode/encode, and the vote path is nothing but element access. Flattening is what put
 * the shape back inside the ceiling, so this pins that it stays there.
 *
 * The measurement is `appBudgetConsumed` off a simulate of the real SDK-built group; every op on
 * this path costs 1, so it is also the opcode count. The vote is then actually sent, which is what
 * exercises the budget planner end to end — a regression past the ceiling fails here as the same
 * error a user would get.
 */
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { AtomicTransactionComposer, getApplicationAddress, makeEmptyTransactionSigner, modelsv2 } from 'algosdk'
import { FracDelegationInstanceClient } from 'frac-delegation-sdk'
import { GGovCommitteeFile, GGovSDK } from 'ggov-sdk'
import { beforeAll, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import { createSDK, deployFracInstance, deployRegistry, generateAccountWithFracSDK } from '../common-tests'
import { configureTestLogging } from '../test-utils'

/** The xALGO shape: the pool whose vote the pooled budget could not pay for. */
const TOPICS = 22
const OPTIONS = 3
const ESCROWS = 6

/**
 * Ceiling for the whole group's opcode burn. Well under the ~171,800 a group can actually pool, so
 * this fails on a regression long before votes start being refused, and far enough above the
 * measured 81,810 to leave room for ordinary contract growth. A nested-shaped regression (213,875)
 * clears it by more than 90k.
 */
const MAX_GROUP_OPCODES = 120_000

/** The voter's AQ weight, and — since the ledger must be complete to vote — the committee total. */
const VOTER_AQ = 6

const topicOptions = Array.from({ length: TOPICS }, (_, t) =>
  Array.from({ length: OPTIONS }, (_, o) => (o === OPTIONS - 1 ? 'Abstain' : `T${t}O${o}`)),
)

/** A ballot spending the voter's full weight on every topic's first option. */
const ballotFor = (weight: number) =>
  Array.from({ length: TOPICS }, () => Array.from({ length: OPTIONS }, (_, o) => (o === 0 ? weight : 0)))

const fixture = algorandFixture()

describe('fractional vote opcode budget', () => {
  beforeAll(async () => {
    configureTestLogging()
    await fixture.newScope()
  })

  /**
   * Stand up the whole voting stack: a gGov committee of escrows with `powers`, a frac instance
   * holding them, a ready period shaped to `topics`, and one AQ voter of weight `voterAq` against a
   * ledger of `totalAq` (which must be fully ingested before a vote passes the completeness gate).
   */
  const setupVoting = async ({
    powers,
    topics,
    totalAq,
    voterAq,
  }: {
    powers: number[]
    topics: string[][]
    totalAq: number
    voterAq: number
  }) => {
    const localnet = fixture as AlgorandFixture
    const { testAccount } = localnet.context

    // ── gGov side: a committee whose members are the instance's escrows ──
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

    // ── frac side: an instance whose escrows are those committee members ──
    const { appId: instanceAppId, instanceId, sdk } = await deployFracInstance(localnet, testAccount)
    const registrySdk = sdk.registry
    await registrySdk.setGGovRegistryApp({ appId: ggovRegistrySdk.appId })
    await ggovSdk.registry.setFracRegistryApp({ appId: registrySdk.appId })
    for (const account of escrowAccounts) {
      await registrySdk.registerEscrow({ instanceNumId: instanceId, account: account.toString() })
    }
    await sdk.syncCommittee({ instanceNumId: instanceId, committeeId })

    const instanceAppAddress = getApplicationAddress(instanceAppId).toString()
    await localnet.algorand.account.ensureFundedFromEnvironment(instanceAppAddress, (20).algos())
    await localnet.algorand.account.ensureFundedFromEnvironment(
      sdk.registryReadClient.appAddress.toString(),
      (10).algos(),
    )
    await localnet.algorand.account.ensureFundedFromEnvironment(
      getApplicationAddress(ggovRegistrySdk.appId).toString(),
      (10).algos(),
    )
    for (const escrow of escrowAccounts) {
      await createSDK(localnet, ggovRegistrySdk.appId, escrow).setVotingAccount({
        votingAddress: instanceAppAddress,
      })
    }

    // ── a ready period with the benchmark's topic shape, synced into the instance ──
    const now = BigInt(Math.floor(Date.now() / 1000))
    const periodId = await ggovSdk.registry.addPeriod({
      committeeId,
      votingStart: now + 10_000n,
      votingEnd: now + 20_000n,
    })
    for (const options of topics) await ggovSdk.addTopic({ periodId, options })
    await ggovSdk.editPeriod({ periodId, committeeId, votingStart: now - 600n, votingEnd: now + 3600n })
    await ggovSdk.setReady({ periodId, ready: true })
    const periodAppId = await ggovSdk.getPeriodAppId(periodId)
    await localnet.algorand.account.ensureFundedFromEnvironment(
      getApplicationAddress(periodAppId).toString(),
      (10).algos(),
    )
    await sdk.syncPeriod({ instanceNumId: instanceId, periodApp: periodAppId })
    const committeeNumId = (await sdk.getCommittee(instanceId, committeeId))!.committeeNumId

    // ── one AQ voter, and a complete ledger (ingested must equal total to vote) ──
    await sdk.startAqIngest({ instanceNumId: instanceId, committeeId, totalAq, totalAccounts: 1 })
    const { account: voter, sdk: voterSdk } = await generateAccountWithFracSDK(localnet, sdk.appId, (5).algos())
    await sdk.ingestAq({
      instanceNumId: instanceId,
      committeeNumId,
      accountAqs: [[voter.toString(), voterAq]],
    })

    return { localnet, sdk, ggovSdk, instanceId, periodId, voter, voterSdk }
  }

  test(
    `a ${TOPICS}-topic vote across ${ESCROWS} escrows stays inside the pooled opcode budget`,
    async () => {
      const { localnet, sdk, instanceId, periodId, voter, voterSdk } = await setupVoting({
        powers: Array.from({ length: ESCROWS }, (_, i) => 10 + i),
        topics: topicOptions,
        totalAq: VOTER_AQ,
        voterAq: VOTER_AQ,
      })
      const ballot = ballotFor(VOTER_AQ)

      // Measure the *first* vote: it is the expensive one, re-casting every escrow on every topic.
      // Simulating changes nothing, so the send below is still that first vote.
      const instanceClient = new FracDelegationInstanceClient({
        algorand: localnet.algorand,
        appId: await sdk.getInstanceAppId(instanceId),
        defaultSender: voter,
        defaultSigner: localnet.algorand.account.getSigner(voter),
      })
      const builder = await voterSdk.makeVoteTxns({
        instanceNumId: instanceId,
        periodId,
        voterAccount: voter.toString(),
        topicVotes: ballot,
        client: instanceClient,
      })
      const { transactions } = await (await builder.composer()).buildTransactions()
      const atc = new AtomicTransactionComposer()
      // One fee-bearing transaction covers the group; the signatures are stubbed out below.
      transactions[0].fee = 256_000n
      for (const txn of transactions) atc.addTransaction({ txn, signer: makeEmptyTransactionSigner() })
      const { simulateResponse } = await atc.simulate(
        localnet.algorand.client.algod,
        new modelsv2.SimulateRequest({
          txnGroups: [],
          allowMoreLogging: true,
          allowUnnamedResources: true,
          // Far above anything the group can pool on its own, so the measurement is of the vote
          // rather than of what happened to fit.
          extraOpcodeBudget: 320_000,
          fixSigners: true,
          allowEmptySignatures: true,
        }),
      )
      const group = simulateResponse.txnGroups[0]
      expect(group.failureMessage ?? '').toBe('')

      const consumed = Number(group.appBudgetConsumed ?? 0)
      console.log(`frac vote (${TOPICS} topics x ${OPTIONS} options, ${ESCROWS} escrows): ${consumed} opcodes`)
      expect(consumed).toBeLessThanOrEqual(MAX_GROUP_OPCODES)

      // And it must actually send: this is the path that plans the opup calls, and the one that
      // refused xALGO outright when the burn was over the ceiling.
      await voterSdk.vote({ instanceNumId: instanceId, periodId, topicVotes: ballot })

      // The whole ballot landed, so the budget bought a real vote and not an early exit.
      const cache = (await sdk.getPeriodVoteCache(instanceId, periodId))!
      expect(cache.internal).toEqual(ballot)
    },
    10 * 60 * 1000,
  )
})
