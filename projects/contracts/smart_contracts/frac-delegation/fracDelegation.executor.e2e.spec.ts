import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import {
  ABIMethod,
  addressWithSignersFromRawFalcon1024Signer,
  decodeUint64,
  generateAccount,
  getApplicationAddress,
  Transaction,
} from 'algosdk'
import { FracDelegationInstanceClient, FracDelegationRegistrySDK, FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovCommitteeFile, GGovSDK } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import committeeTemplate from '../../../common/committee-files/template.json'
import { makeProbeContext, planGroupExtras } from '../../../sdk-shared/src/increaseBudget'
import {
  createSDK,
  deployFracInstance,
  deployFracRegistry,
  deployRegistry,
  deployRegistryWithCommittee,
} from '../common-tests'
import { configureTestLogging } from '../test-utils'

// The SDK executor (sdk-shared/src/{txnExecutor,increaseBudget}.ts) sizes every
// write's group off simulate: reference-slot pads, the opup's inner-txn count, and the AVM v13
// usage fee. This spec pins the observable shape of what it sends; the methods themselves are
// covered by their own specs.

const MIN_FEE = 1000n
const INCREASE_BUDGET_SELECTOR = new ABIMethod({
  name: 'increaseBudget',
  args: [{ type: 'uint64', name: 'itxns' }],
  returns: { type: 'void' },
}).getSelector()

const isIncreaseBudget = (txn: Transaction) =>
  txn.type === 'appl' && Buffer.from(txn.applicationCall!.appArgs[0]).equals(Buffer.from(INCREASE_BUDGET_SELECTOR))

const opupItxns = (txn: Transaction) => Number(decodeUint64(txn.applicationCall!.appArgs[1], 'safe'))

/** The group's leading increaseBudget calls and the real call(s) after them. */
const splitGroup = (txns: Transaction[]) => {
  const prepends: Transaction[] = []
  let i = 0
  while (i < txns.length && isIncreaseBudget(txns[i])) prepends.push(txns[i++])
  return { prepends, rest: txns.slice(i) }
}

const freshAccounts = (n: number) => Array.from({ length: n }, () => generateAccount().addr.toString())

/** Falcon-1024 public key length, so the placeholder envelope is the size of a real one. */
const FALCON_1024_PUBLIC_KEY_BYTES = 1793

/**
 * A post-quantum account the SDK can size for but nobody can sign for: a placeholder Falcon-1024
 * public key, the address it derives, and the empty signer that reproduces its envelope.
 *
 * That is enough for the probe path, which never signs — algod reads the envelope under
 * `allowEmptySignatures` and charges the surcharge. It is not enough to send: a real PQ writer
 * needs a real Falcon key, which the test setup has no source for.
 */
const pqWriter = () =>
  addressWithSignersFromRawFalcon1024Signer({
    falcon1024PublicKey: new Uint8Array(FALCON_1024_PUBLIC_KEY_BYTES).fill(7),
    falcon1024Signer: () => Promise.reject(new Error('placeholder PQ key: sizing only')),
  })

/**
 * gGov registry + committee of `powers`, and a frac instance bound to it with every committee
 * member registered as an escrow and delegating to the instance — the minimum for a vote that
 * re-casts through every escrow. Trimmed from fracDelegationInstance.vote.e2e.spec.ts's setup.
 */
const setupVoting = async (localnet: AlgorandFixture, powers: number[], totalAq = 100) => {
  const { testAccount } = localnet.context
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
  await sdk.registry.setGGovRegistryApp({ appId: ggovRegistrySdk.appId })
  await ggovSdk.registry.setFracRegistryApp({ appId: sdk.registry.appId })
  for (const account of escrowAccounts) {
    await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: account.toString() })
  }
  await sdk.syncCommittee({ instanceNumId: instanceId, committeeId })

  const instanceAppAddress = getApplicationAddress(instanceAppId).toString()
  await localnet.algorand.account.ensureFundedFromEnvironment(instanceAppAddress, (10).algos())
  await localnet.algorand.account.ensureFundedFromEnvironment(sdk.registryReadClient.appAddress, (5).algos())
  for (const escrow of escrowAccounts) {
    await createSDK(localnet, ggovRegistrySdk.appId, escrow).setVotingAccount({ votingAddress: instanceAppAddress })
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const periodId = await ggovSdk.registry.addPeriod({
    committeeId,
    votingStart: now + 10_000n,
    votingEnd: now + 20_000n,
  })
  await ggovSdk.addTopic({ periodId, options: ['A', 'B', 'Abstain'] })
  await ggovSdk.editPeriod({ periodId, committeeId, votingStart: now - 600n, votingEnd: now + 3600n })
  await ggovSdk.setReady({ periodId, ready: true })
  const periodAppId = await ggovSdk.getPeriodAppId(periodId)
  await sdk.syncPeriod({ instanceNumId: instanceId, periodApp: periodAppId })
  const committeeNumId = (await sdk.getCommittee(instanceId, committeeId))!.committeeNumId
  await sdk.startAqIngest({ instanceNumId: instanceId, committeeId, totalAq, totalAccounts: 1 })

  return { sdk, instanceId, instanceAppId, committeeNumId, periodId, totalAq }
}

type VotingCtx = Awaited<ReturnType<typeof setupVoting>>

/** A voter funded with `funds`, holding the whole AQ ledger. */
const addVoter = async (localnet: AlgorandFixture, ctx: VotingCtx, funds = (2).algos()) => {
  const account = await localnet.context.generateAccount({ initialFunds: funds })
  await ctx.sdk.ingestAq({
    instanceNumId: ctx.instanceId,
    committeeNumId: ctx.committeeNumId,
    accountAqs: [[account.toString(), ctx.totalAq]],
  })
  const sdk = new FracDelegationSDK({
    algorand: localnet.algorand,
    registryAppId: ctx.sdk.registry.appId,
    writerAccount: { sender: account, signer: localnet.algorand.account.getSigner(account) },
  })
  return { account, sdk }
}

/**
 * Count every simulate that reaches algod while `fn` runs — the executor's own sizing probes and
 * algokit's resource-population pass alike. Both go through `algod.simulateTransactions`, and the
 * SDKs share the fixture's algod instance, so one hook sees all of them.
 */
const countSimulates = async <T>(localnet: AlgorandFixture, fn: () => Promise<T>): Promise<[T, number]> => {
  const algod = localnet.algorand.client.algod
  const original = algod.simulateTransactions.bind(algod)
  let count = 0
  algod.simulateTransactions = ((...args: Parameters<typeof original>) => {
    count++
    return original(...args)
  }) as typeof algod.simulateTransactions
  try {
    return [await fn(), count]
  } finally {
    algod.simulateTransactions = original
  }
}

describe('FracDelegation executor', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope, 30_000)

  describe('reference auto-pad', () => {
    test('ingestAq at 40 accounts: the pads come first, the first one carries the itxns', async () => {
      const { testAccount } = localnet.context
      const { sdk: ggovSdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
      const { appId, instanceId, sdk } = await deployFracInstance(localnet, testAccount)
      await sdk.registry.setGGovRegistryApp({ appId: ggovSdk.appId })
      await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: govAccounts[0].toString() })
      await sdk.syncCommittee({ instanceNumId: instanceId, committeeId })
      await localnet.algorand.account.ensureFundedFromEnvironment(getApplicationAddress(appId), (5).algos())
      await localnet.algorand.account.ensureFundedFromEnvironment(sdk.registryReadClient.appAddress, (5).algos())
      await sdk.startAqIngest({ instanceNumId: instanceId, committeeId, totalAq: 400, totalAccounts: 40 })
      const committeeNumId = (await sdk.getCommittee(instanceId, committeeId))!.committeeNumId

      const accounts = freshAccounts(40)
      const result = await sdk.ingestAq({
        instanceNumId: instanceId,
        committeeNumId,
        accountAqs: accounts.map((a) => [a, 10]),
      })

      // 2N+3 = 83 reference slots at 8 per app call: 11 app calls, the ingest itself being one.
      const { prepends, rest } = splitGroup(result.transactions)
      expect(rest).toHaveLength(1)
      expect(prepends.length).toBeGreaterThanOrEqual(10)
      expect(prepends.length).toBeLessThanOrEqual(11)
      expect(prepends.slice(1).map(opupItxns)).toEqual(prepends.slice(1).map(() => 0))
      expect((await sdk.getCommitteeAq(instanceId, committeeNumId))!.numAccounts).toBe(40)
    }, 120_000)

    test('vote at 11 escrows: padded past what one txn carries, and every escrow cast', async () => {
      const ctx = await setupVoting(
        localnet,
        Array.from({ length: 11 }, () => 10),
        110,
      )
      const voter = await addVoter(localnet, ctx)

      const result = await voter.sdk.vote({
        instanceNumId: ctx.instanceId,
        periodId: ctx.periodId,
        topicVotes: [[110, 0, 0]],
      })

      const { prepends, rest } = splitGroup(result.transactions)
      expect(rest).toHaveLength(1)
      // ~5 per escrow + ~22 fixed = ~77 slots -> 10 app calls, one of which is the vote.
      expect(prepends.length).toBeGreaterThanOrEqual(8)
      expect(prepends.slice(1).map(opupItxns)).toEqual(prepends.slice(1).map(() => 0))
      const confirmations = result.confirmations!
      // Direct inners only (each period vote's own two registry reads nest below it): 1 registry
      // resolve + 1 period vote per escrow.
      expect(confirmations[confirmations.length - 1].innerTxns).toHaveLength(1 + 11)
    }, 180_000)
  })

  describe('opup sizing', () => {
    test('an inner-heavy over-budget vote lands below the pessimistic bound', async () => {
      const ctx = await setupVoting(
        localnet,
        Array.from({ length: 8 }, () => 10),
        80,
      )
      const voter = await addVoter(localnet, ctx)

      // The bracket the executor searched, computed the same way it does: sim #1 on the bare group.
      const client = new FracDelegationInstanceClient({
        algorand: localnet.algorand,
        appId: ctx.instanceAppId,
        defaultSender: voter.account,
        defaultSigner: localnet.algorand.account.getSigner(voter.account),
      })
      const bare = await voter.sdk.makeVoteTxns({
        instanceNumId: ctx.instanceId,
        periodId: ctx.periodId,
        topicVotes: [[80, 0, 0]],
        client,
      })
      const plan = (await planGroupExtras(bare, makeProbeContext(localnet.algorand.client.algod)))!
      expect(plan.itxnsLo).toBeLessThan(plan.itxnsHi)

      const result = await voter.sdk.vote({
        instanceNumId: ctx.instanceId,
        periodId: ctx.periodId,
        topicVotes: [[80, 0, 0]],
      })

      const { prepends } = splitGroup(result.transactions)
      const itxns = opupItxns(prepends[0])
      expect(itxns).toBeLessThan(plan.itxnsHi)
      expect(itxns).toBeGreaterThanOrEqual(plan.itxnsLo)
      expect(result.confirmations![0].innerTxns ?? []).toHaveLength(itxns)
      expect((await ctx.sdk.getPeriodVoteCache(ctx.instanceId, ctx.periodId))!.internal).toEqual([[80, 0, 0]])
    }, 180_000)
  })

  describe('fees', () => {
    test('a classic group pays computed fees: the vote min fee + its inner calls, the opup min fee + its itxns', async () => {
      const ctx = await setupVoting(localnet, [15, 15, 20])
      const voter = await addVoter(localnet, ctx)

      const result = await voter.sdk.vote({
        instanceNumId: ctx.instanceId,
        periodId: ctx.periodId,
        topicVotes: [[100, 0, 0]],
      })

      const { prepends, rest } = splitGroup(result.transactions)
      expect(rest[0].fee).toBe(MIN_FEE + BigInt(1 + 3 * 3) * MIN_FEE)
      for (const [i, pad] of prepends.entries()) {
        expect(pad.fee).toBe(MIN_FEE + BigInt(i === 0 ? opupItxns(pad) : 0) * MIN_FEE)
      }
    }, 120_000)

    test('a writer that cannot cover the probe headroom still gets its group sized and sent', async () => {
      const ctx = await setupVoting(localnet, [15, 15, 20])
      // Spendable ~0.1 ALGO: under the 0.256 the first probe attempt puts on txn 0, well over the
      // ~0.015 the group really costs.
      const voter = await addVoter(localnet, ctx, (200_000).microAlgo())
      const before = (await localnet.algorand.account.getInformation(voter.account)).balance.microAlgo

      const result = await voter.sdk.vote({
        instanceNumId: ctx.instanceId,
        periodId: ctx.periodId,
        topicVotes: [[100, 0, 0]],
      })

      const { prepends, rest } = splitGroup(result.transactions)
      expect(rest[0].fee).toBe(MIN_FEE + BigInt(1 + 3 * 3) * MIN_FEE)
      const paid = result.transactions.reduce((sum, t) => sum + t.fee, 0n)
      // One min fee per txn, plus the opup's itxns and the vote's 1 + 3 * 3 inner calls.
      expect(paid).toBe(
        MIN_FEE * BigInt(result.transactions.length) + BigInt(opupItxns(prepends[0])) * MIN_FEE + 10n * MIN_FEE,
      )
      const after = (await localnet.algorand.account.getInformation(voter.account)).balance.microAlgo
      expect(before - after).toBe(paid)
    }, 120_000)
  })

  // Every simulate is a round trip, so the executor's whole job is to learn what it needs in as
  // few as possible. These pin the budget: a regression that reprobes shows up here first.
  describe('simulate budget', () => {
    test('a write that needs nothing costs two simulates: sizing, then send', async () => {
      const { testAccount } = localnet.context
      const { instanceId, sdk } = await deployFracInstance(localnet, testAccount)

      const [, count] = await countSimulates(localnet, () =>
        sdk.setOperator({ instanceNumId: instanceId, newOperator: testAccount.toString() }),
      )
      expect(count).toBe(2)
    }, 120_000)

    test('an inner-heavy vote stays inside its probe budget', async () => {
      const ctx = await setupVoting(localnet, [15, 15, 20])
      const voter = await addVoter(localnet, ctx)

      const [, count] = await countSimulates(localnet, () =>
        voter.sdk.vote({ instanceNumId: ctx.instanceId, periodId: ctx.periodId, topicVotes: [[100, 0, 0]] }),
      )
      // The maker's own escrow read, Sim #1, one opup probe, and the send's population pass. The
      // maker re-runs twice more while the group is sized; the read cache is what keeps those free.
      // Ceiling is 6: Sim #1 plus three probes plus the send, on top of that first read.
      expect(count).toBe(4)
    }, 180_000)

    test('a writer below the probe headroom costs exactly one extra simulate, not one per probe', async () => {
      const funded = await setupVoting(localnet, [15, 15, 20])
      const fundedVoter = await addVoter(localnet, funded)
      const [, fundedCount] = await countSimulates(localnet, () =>
        fundedVoter.sdk.vote({
          instanceNumId: funded.instanceId,
          periodId: funded.periodId,
          topicVotes: [[100, 0, 0]],
        }),
      )

      await localnet.newScope()
      const poor = await setupVoting(localnet, [15, 15, 20])
      // Spendable ~0.1 ALGO: under the 0.256 the first probe attempt puts on txn 0.
      const poorVoter = await addVoter(localnet, poor, (200_000).microAlgo())
      const [, poorCount] = await countSimulates(localnet, () =>
        poorVoter.sdk.vote({ instanceNumId: poor.instanceId, periodId: poor.periodId, topicVotes: [[100, 0, 0]] }),
      )

      // The headroom is re-derived once and cached for the run; every later probe reuses it.
      expect(poorCount).toBe(fundedCount + 1)
    }, 300_000)
  })

  /**
   * The AVM v13 post-quantum premium is priced off the signature envelope, not the sender address:
   * algod does not infer PQ-ness from a PQ sender. So the sizing simulates see the surcharge only
   * when the writer hands over its own placeholder signer (`writerAccount.emptyTxnSigner`).
   * Measured against localnet: a flat 3x per PQ-authorized transaction.
   */
  describe('post-quantum pricing', () => {
    // Probe-only, and it has to be: the placeholder key cannot produce a signature, so this covers
    // the sizing path and nothing past it. A genuinely PQ-signed send — and the send-time
    // `/fees is less than/` retry that catches a PQ writer with no `emptyTxnSigner` — needs a real
    // Falcon key. Binding the envelope to an ordinary ed25519 account is not a way around that:
    // once the probe's fee headroom carries the group past the usage check, algod reaches
    // signature validation and rejects it with a "pq signature authorizer mismatch".
    test('the premium is measured only when the writer supplies its own empty signer', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      const { address: pqAddress, emptyTxnSigner } = pqWriter()
      // The probe puts fee headroom on txn 0, so the PQ account has to be able to cover it.
      await localnet.algorand.account.ensureFundedFromEnvironment(pqAddress, (2).algos())
      await sdk.setAdmin({ newAdmin: pqAddress.toString() })

      const pqSdk = new FracDelegationRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: sdk.appId,
        writerAccount: {
          sender: pqAddress,
          signer: () => Promise.reject(new Error('the placeholder PQ account cannot sign')),
          emptyTxnSigner,
        },
      })
      const algod = localnet.algorand.client.algod
      const newDefaultOperator = freshAccounts(1)[0]

      // A plain empty signer carries no envelope, so this measures as a classic group: one txn at
      // one usage unit, inside the free allowance, needing nothing at all.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const classic = await pqSdk.makeSetDefaultOperatorTxns({ newDefaultOperator })
      expect(await planGroupExtras(classic, makeProbeContext(algod))).toBeUndefined()

      // The same group with the writer's own signer: 3x usage puts it past the allowance, so the
      // fee now has to be read off simulate. Nothing else changes — no pads, no opup — and the
      // prepend that ends up carrying the fee comes from `applyPrepends` flooring the count at 1,
      // which the usage-fee test below observes on a group that is actually sent.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const pq = await pqSdk.makeSetDefaultOperatorTxns({ newDefaultOperator })
      expect(await planGroupExtras(pq, makeProbeContext(algod, emptyTxnSigner))).toMatchObject({
        padsForRefs: 0,
        itxnsLo: 0,
        itxnsHi: 0,
        prepends: 0,
        feeCheckNeeded: true,
      })
    }, 120_000)
  })

  // The approval upload is the one write that routinely trips the v13 usage fee without a PQ
  // signer: ~5KB of application arguments puts the group past the free allowance. It declares no
  // box references and no fee of its own — the executor measures both — so this also pins that.
  describe('usage fee', () => {
    test('the premium rides on the opup, and the upload needs no hand-declared references', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployFracRegistry(localnet, testAccount)
      await localnet.algorand.account.ensureFundedFromEnvironment(sdk.readClient.appAddress, (5).algos())
      const bytecode = new Uint8Array(5000).fill(0xff)

      const [result, count] = await countSimulates(localnet, () =>
        sdk.uploadInstanceApproval({
          page1: bytecode.subarray(0, 4094),
          page2: bytecode.subarray(4094, 8188),
          page3: bytecode.subarray(8188),
        }),
      )

      const { prepends, rest } = splitGroup(result.transactions)
      expect(prepends).toHaveLength(1)
      expect(opupItxns(prepends[0])).toBe(0)
      expect(rest).toHaveLength(1)
      // The upload keeps the min fee it was built with; the whole usage premium is on the prepend.
      expect(rest[0].fee).toBe(MIN_FEE)
      expect(prepends[0].fee).toBeGreaterThan(MIN_FEE)
      // Sim #1, the fee read, then the send's population pass — which is also what places the box
      // references this call no longer declares.
      expect(count).toBe(3)
      expect(await localnet.algorand.app.getBoxValue(sdk.appId, 'Iap')).toEqual(bytecode)
    }, 120_000)
  })
})
