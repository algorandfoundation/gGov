/**
 * Seed the localnet the pipeline has already populated with gGov voting periods — the one thing no
 * pipeline run ever creates. Same three-period shape the frontend seed builds
 * (`ggov-frontend/scripts/deploy-sample-data.ts`): an ended election, an active two-election period
 * and an upcoming standard vote, each snapshotted onto every frac instance that can carry it.
 *
 * USAGE
 *   pnpm seed-periods                    # for the committee the seed file names
 *   pnpm seed-periods <committee-id>     # for any other committee already on the gGov registry
 *
 * REQUIREMENTS
 *   A seeded localnet the pipeline has run against — `pnpm seed-localnet-data` + `pnpm test-pipeline`,
 *   or `pnpm seed-full-instances` — since a period is bound to a committee and `syncPeriod` needs the
 *   instances to already hold that committee's snapshot. Reads `.localnet-seed.json` and writes
 *   nothing back to it: periods live on chain only.
 *
 * WHICH COMMITTEE
 *   The one the seed file currently names, i.e. the one the last pipeline run reconciled — or the
 *   base64 committee id given as an argument, for an earlier one the registry still holds (a seed
 *   file left behind by another flow is the usual reason to reach for it). Run it again after
 *   `pnpm add-committee` + `pnpm test-pipeline` to add periods for the next committee.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   No votes. The committee's escrows are real mainnet addresses and its AlgoQuarters holders are
 *   real mainnet accounts, so nothing here can sign an internal vote — unlike the frontend seed,
 *   whose voters are all generated. What this exercises is the operator half: period creation,
 *   topics, readiness, and `syncPeriod` against the instances' real escrow counts.
 *
 * RE-RUNNABLE
 *   Every run appends a fresh set of periods rather than editing the previous one — a period is
 *   frozen by `setReady` and the ended one is backdated, so neither can be moved afterwards.
 *
 * STEPS
 * 1) Read the seed file and reattach the deployer's signer.
 * 2) Find the instances holding the committee's snapshot; the rest cannot be synced.
 * 3) Top those instances up for the box MBR `syncPeriod` lands on them.
 * 4) Create each period: body, topics, ready, then sync it onto every instance.
 * 5) Print the summary.
 */

import { randomBytes } from 'node:crypto'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovSDK } from 'ggov-sdk'
import type { Election } from 'ggov-sdk'
import pMap from 'p-map'
import { CjsAlgorandClient, algosdk, configLogger, num, printSections, readSeedFile } from './seed-common.ts'

configLogger()

// =========================================================
// PERIOD DEFINITIONS
// =========================================================

const HOUR = 3_600n
const DAY = 24n * HOUR

/**
 * A period to create. `elect` present makes it an election period: its topics are candidates, each
 * tagged with `e`, the index of the race it runs in, and all of them get the Support/Veto/Abstain
 * option set frac voting requires (Abstain last). Absent, the topics are plain proposals.
 *
 * The window is relative to the run, so every run lands one period in each of the three states the
 * UI derives from `votingStart`/`votingEnd` vs now.
 */
type PeriodSpec = {
  /** State this period is created in, for the log and the summary. */
  state: 'ENDED' | 'ACTIVE' | 'UPCOMING'
  title: string
  body: string
  elect?: Election[]
  topics: { title: string; body: string; options?: string[]; e?: number }[]
  /** Voting window, in seconds relative to the moment the run starts. */
  startOffset: bigint
  endOffset: bigint
}

/**
 * The same races and candidates the frontend seed uses, so both localnets read alike — what differs
 * is that these carry no votes (see WHAT THIS DELIBERATELY DOES NOT DO).
 *
 * The ended period is simply created with a window already in the past: nothing votes in it, so it
 * needs none of the frontend's cast-then-wait-out dance, and `addTopic`/`setReady` are gated on the
 * period not being ready rather than on the clock.
 */
const PERIODS: PeriodSpec[] = [
  {
    state: 'ENDED',
    title: 'gGov Council — Term 1 election',
    body:
      'Elect 3 council members. Each candidate below is a Support/Veto/Abstain ballot; candidates are ' +
      'ranked by net score (Support − Veto) and the top 3 took the available seats.',
    elect: [{ t: 'xGov Council', s: 3 }],
    topics: [
      { title: 'txnlab.algo', body: 'AlgoKit core maintainer and developer tooling.' },
      { title: 'folks.algo', body: 'Folks Finance lending protocol contributor.' },
      { title: 'nodely.algo', body: 'Infrastructure, indexer and node operator.' },
      { title: 'reti.algo', body: 'Reti staking pool collective.' },
      { title: 'gard.algo', body: 'GARD stablecoin protocol team.' },
    ],
    startOffset: -14n * DAY,
    endOffset: -7n * DAY,
  },
  {
    // Two races on one ballot: one committee, one window, one vote(). `e` is an index into `elect`,
    // so this list is append-only — reordering it silently re-tags every candidate below.
    state: 'ACTIVE',
    title: 'gGov Council — Term 2 elections',
    body:
      'Elect 3 council members and 1 EAC member. Each candidate below is a Support/Veto/Abstain ballot; ' +
      'candidates are ranked by net score (Support − Veto) within their own election, and the top scorers ' +
      'lead for that election’s seats.',
    elect: [
      { t: 'xGov Council', s: 3 },
      { t: 'EAC', s: 1 },
    ],
    topics: [
      { title: 'txnlab.algo', body: 'AlgoKit core maintainer and developer tooling.', e: 0 },
      { title: 'folks.algo', body: 'Folks Finance lending protocol contributor.', e: 0 },
      { title: 'nodely.algo', body: 'Infrastructure, indexer and node operator.', e: 0 },
      { title: 'reti.algo', body: 'Reti staking pool collective.', e: 0 },
      { title: 'gard.algo', body: 'GARD stablecoin protocol team.', e: 1 },
      { title: 'pact.algo', body: 'Pact AMM protocol and treasury tooling.', e: 1 },
      { title: 'tinyman.algo', body: 'Tinyman AMM liquidity and grants steward.', e: 1 },
    ],
    startOffset: -1n * HOUR,
    endOffset: 7n * DAY,
  },
  {
    state: 'UPCOMING',
    title: 'Protocol & Ecosystem Governance',
    body: 'Upcoming governance period covering protocol upgrades and ecosystem strategy.',
    topics: [
      {
        title: 'Protocol Upgrade v2.0',
        body: 'Approve deployment of Protocol v2.0 (state proofs, block pipelining).',
      },
      {
        title: 'Ecosystem Development Fund',
        body: 'Allocate 1M ALGO to an ecosystem development fund for grants and tooling.',
      },
    ],
    startOffset: 14n * DAY,
    endOffset: 28n * DAY,
  },
]

/** Options every candidate of an election period carries. Abstain must be last — frac voting relies on it. */
const CANDIDATE_OPTIONS = ['Support', 'Veto', 'Abstain']

/** Options a standard topic carries when it doesn't name its own. Abstain last, same reason. */
const DEFAULT_TOPIC_OPTIONS = ['Yes', 'No', 'Abstain']

/**
 * µALGO of headroom above min balance each instance app is topped up to before the periods are
 * synced onto it. `syncPeriod` writes the period record, the vote cache and one box per snapshotted
 * escrow, all paid by the instance app itself — and unlike `vote` it has no `checkNeedMBR` path to
 * pull a top-up from the registry, so an instance sitting at exactly its MBR (where the AQ ingest's
 * `autoFund` leaves it) fails resource population instead. ~0.2 ALGO per period covers the shapes
 * here; the floor is deliberately generous, and whatever is left stays on the instance.
 */
const INSTANCE_HEADROOM_MICROALGOS = 3_000_000n

/** How many instances are funded, and later synced, at a time. Matches the SDK readers' default. */
const CONCURRENCY = 4

// =========================================================
// HELPERS
// =========================================================

/** Random 8-byte note, so a re-run's otherwise identical payments are not duplicate transactions. */
const randomNote = () => new Uint8Array(randomBytes(8))

const ts = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16)

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/5] ${label}`)

async function main() {
  step('Reading seed file…')

  const seed = readSeedFile()
  const algorand = CjsAlgorandClient.defaultLocalNet()

  // The registries' creator is their operator, and only the operator may create a period or sync one.
  const deployer = algorand.account.fromMnemonic(seed.accounts.deployer.mnemonic)
  const deployerAccount = { sender: deployer.addr.toString(), signer: deployer.signer }

  // A stale seed file outlives the localnet it describes; fail here rather than several calls deep.
  try {
    await algorand.app.getById(BigInt(seed.gGovRegistryAppId))
  } catch {
    throw new Error(
      `gGov registry ${seed.gGovRegistryAppId} does not exist on localnet — re-run \`pnpm seed-localnet-data\``,
    )
  }

  const sdk = new GGovSDK({ algorand, registryAppId: BigInt(seed.gGovRegistryAppId), writerAccount: deployerAccount })
  const fracSdk = new FracDelegationSDK({
    algorand,
    registryAppId: BigInt(seed.fracRegistryAppId),
    writerAccount: deployerAccount,
  })

  const committeeId = process.argv[2] ?? seed.committeeId
  const committee = await sdk.registry.getCommitteeMetadata(committeeId)
  if (!committee) {
    throw new Error(
      `Committee ${committeeId} is not on gGov registry ${seed.gGovRegistryAppId} — the seed file may ` +
        `describe a different localnet than the one running. On chain: ` +
        `${(await sdk.registry.getCommitteeIds()).map((id) => Buffer.from(id).toString('base64')).join(', ') || 'none'}`,
    )
  }
  console.log(
    `  committee ${committeeId} · ${num(committee.totalMembers)} members · ${num(committee.totalVotes)} votes · ` +
      `rounds ${num(committee.periodStart)}–${num(committee.periodEnd)}`,
  )

  step('Finding instances that can carry a period…')

  // Only instances holding this committee's snapshot: `syncPeriod` sizes its per-escrow boxes from
  // that snapshot and refuses the period without it (ERR:C_NX). An instance whose AQ was skipped —
  // no eligible account, or a source with no AQ engine — never had `syncCommittee` run for this
  // committee, so it is reported and left alone rather than silently failing mid-run.
  const instances = [...(await fracSdk.registry.getExistingInstances())].map(([numId, instance]) => ({
    numId,
    ...instance,
  }))
  if (instances.length === 0) throw new Error('No instances on the frac registry — run `pnpm test-pipeline` first')

  const snapshots = await pMap(instances, (i) => fracSdk.getCommittee(i.numId, committeeId), {
    concurrency: CONCURRENCY,
  })
  const syncable = instances.filter((_, i) => snapshots[i] !== undefined)
  const unsynced = instances.filter((_, i) => snapshots[i] === undefined)
  console.log(
    `  ${syncable.length}/${instances.length} instances hold the committee` +
      (unsynced.length ? ` · skipping ${unsynced.map((i) => i.name).join(', ')}` : ''),
  )
  if (syncable.length === 0) {
    throw new Error(
      `No instance holds committee ${committeeId} — run \`pnpm test-pipeline\` for it before seeding periods`,
    )
  }

  step('Topping the instances up for period box MBR…')

  await pMap(
    syncable,
    async ({ appId, name }) => {
      const address = algosdk.getApplicationAddress(appId).toString()
      const { balance, minBalance } = await algorand.account.getInformation(address)
      const target = minBalance.microAlgo + INSTANCE_HEADROOM_MICROALGOS
      if (balance.microAlgo >= target) return
      const shortfall = target - balance.microAlgo
      await algorand.send.payment({
        sender: deployerAccount.sender,
        receiver: address,
        amount: microAlgos(shortfall),
        note: randomNote(),
      })
      console.log(`  ${name}: +${(Number(shortfall) / 1e6).toFixed(2)} ALGO`)
    },
    { concurrency: CONCURRENCY },
  )

  step(`Creating ${PERIODS.length} periods…`)

  const now = BigInt(Math.floor(Date.now() / 1000))
  const created: { spec: PeriodSpec; periodId: bigint; appId: bigint; start: bigint; end: bigint }[] = []

  for (const spec of PERIODS) {
    const votingStart = now + spec.startOffset
    const votingEnd = now + spec.endOffset

    // The final window goes in at creation: `addTopic` and `setReady` are gated on the period not
    // being ready, not on the clock, so a period can be built inside a window that has already
    // closed. (The frontend seed opens a future window first only because it votes in period 1.)
    const periodId = (await sdk.registry.addPeriod({ committeeId, votingStart, votingEnd })) as bigint
    await sdk.uploadPeriodBody({
      periodId,
      body: { title: spec.title, body: spec.body, ...(spec.elect !== undefined ? { elect: spec.elect } : {}) },
    })
    for (const topic of spec.topics) {
      // addTopicWithBody packs addTopic + the body chunks into one atomic, single-signature group.
      await sdk.addTopicWithBody({
        periodId,
        options: spec.elect !== undefined ? CANDIDATE_OPTIONS : (topic.options ?? DEFAULT_TOPIC_OPTIONS),
        // A candidate joins one race by its index into `elect`. Tagging is mandatory — an untagged
        // one is an authoring error, not election 0 — but a single-race period needn't say so.
        body: { title: topic.title, body: topic.body, ...(spec.elect !== undefined ? { e: topic.e ?? 0 } : {}) },
        note: randomNote(),
      })
    }
    // Freezes the topic set, which is what `syncPeriod` snapshots — it refuses an unready period
    // (ERR:GP_NR) precisely because a shape that can still change would drift out from under it.
    await sdk.setReady({ periodId, ready: true })

    const appId = await sdk.getPeriodAppId(periodId)
    // Nothing votes here, so the period app needs no funding of its own: on a first vote it pulls
    // the vote-record box MBR off the registry via `checkNeedMBR`.
    await pMap(syncable, ({ numId }) => fracSdk.syncPeriod({ instanceNumId: numId, periodApp: appId }), {
      concurrency: CONCURRENCY,
    })

    created.push({ spec, periodId, appId, start: votingStart, end: votingEnd })
    console.log(
      `  #${periodId} ${spec.state.padEnd(8)} app ${appId} · ${spec.topics.length} topics · synced on ${syncable.length} instances`,
    )
  }

  step('Done.')

  const sections: { label: string; rows: string[] }[] = []
  const section = (label: string, ...rows: string[]) => sections.push({ label, rows })

  section(
    'REGISTRIES',
    `gGov  ${seed.gGovRegistryAppId}`,
    `frac  ${seed.fracRegistryAppId}`,
    `deployer ${deployerAccount.sender} (admin + operator of both)`,
  )
  section(
    'COMMITTEE',
    committeeId,
    `${num(committee.totalMembers)} members · ${num(committee.totalVotes)} votes · ` +
      `rounds ${num(committee.periodStart)}–${num(committee.periodEnd)}`,
  )
  section(
    'PERIODS',
    ...created.map(
      ({ spec, periodId, appId, start, end }) =>
        `#${periodId} ${spec.state.padEnd(8)} app ${appId}  ${ts(start)} → ${ts(end)}  ` +
        `${spec.elect ? `${spec.elect.length} race${spec.elect.length === 1 ? '' : 's'}, ` : ''}` +
        `${spec.topics.length} topics`,
    ),
  )
  section('SYNCED', ...syncable.map(({ numId, name, numEscrows }) => `#${numId} ${name} · ${numEscrows} escrows`))
  if (unsynced.length) {
    section('NOT SYNCED', ...unsynced.map(({ numId, name }) => `#${numId} ${name} · no snapshot of this committee`))
  }

  // Every period on the registry, not just this run's: re-runs stack sets of three.
  const all = await sdk.registry.getAllPeriodSummaries()
  section('ON CHAIN', `${all.length} periods on the gGov registry`)

  printSections('FRAC PIPELINE LOCALNET — PERIODS', sections)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
