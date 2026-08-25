/**
 * COUNCIL ELECTION PREVIEW — a fake second xGov Council election on the mirror seed.
 *
 * Creates one election period on the gGov registry `seed-mirror` populated, shaped after the real
 * first council election (governance period 15, voting session 1): its description adapted to a
 * second term, one Yes/No/Abstain measure per candidate, 11 seats — but every candidate mocked
 * (names, bios, project affiliations, handles; see `src/mirror/council-election.ts`). The period is
 * then synced onto every frac instance holding the mirror committee, so both core governors and
 * fractional governors (the synthetic stand-ins included) can preview and vote on it.
 *
 * No votes are cast: that is what the preview is for, and the synthetic accounts are unfunded.
 *
 * USAGE
 *   pnpm seed-council-election                          # localnet, opens now for 8 days
 *   STATE=upcoming pnpm seed-council-election           # opens in 3 days
 *   NETWORK=testnet DEPLOYER_MNEMONIC=… pnpm seed-council-election
 *
 * ENV
 *   NETWORK                localnet | testnet (default localnet); reads `.mirror-seed.<network>.json`
 *   WRITE_ALGOD_SERVER/PORT/TOKEN   testnet algod (default Nodely testnet)
 *   DEPLOYER_MNEMONIC      required on testnet; the registries' operator. Localnet uses the seed file's.
 *   STATE                  active (default) | upcoming | ended — where the voting window sits vs now
 *   VOTING_DAYS            length of the voting window in days (default 8, as the real one)
 *   COMMITTEE_ID           base64 committee to bind the period to (default: the seed file's)
 *   PERIOD_ID              an existing period to sync instead of creating one — resumes a run that
 *                          failed after creation (the log names the id)
 *   CONCURRENCY            instances funded/synced at a time (default 4)
 *
 * RE-RUNNABLE: every run creates a new period (a ready period is frozen), so run it once per preview;
 * `syncPeriod` is idempotent, so PERIOD_ID can be re-run until every instance is synced.
 *
 * STEPS
 * 1) Build the ballot from the period-15 fixture.
 * 2) Connect, reattach the deployer, check the committee is on the registry.
 * 3) Find the instances holding the committee's snapshot; top them up for `syncPeriod`'s box MBR.
 * 4) Create the period: body, candidates, ready.
 * 5) Sync it onto the instances.
 * 6) Print the summary.
 */

import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovSDK } from 'ggov-sdk'
import pMap from 'p-map'
import { buildCouncilElection, type VotingSessionFixture } from '../src/mirror/council-election.ts'
import {
  algosdk,
  configLogger,
  mirrorDeployerMnemonic,
  networkFromEnv,
  num,
  printSections,
  readMirrorSeedFile,
  writeClient,
} from './seed-common.ts'

configLogger()

const FIXTURE = fileURLToPath(
  new URL('../../common/gov-fixtures/voting-session-period-15-voting-session-1.json', import.meta.url),
)

const NETWORK = networkFromEnv()
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)

type State = 'active' | 'upcoming' | 'ended'
const STATE = (process.env.STATE ?? 'active') as State
if (STATE !== 'active' && STATE !== 'upcoming' && STATE !== 'ended')
  throw new Error(`STATE must be active, upcoming or ended, got ${STATE}`)

/** A period an earlier run created but did not finish syncing: skip creation, sync it. */
const PERIOD_ID = process.env.PERIOD_ID ? BigInt(process.env.PERIOD_ID) : undefined

const DAY = 86_400n
const VOTING_DAYS = BigInt(process.env.VOTING_DAYS ?? 8)

/**
 * µALGO of headroom above min balance each instance app is topped up to before the period is synced
 * onto it: `syncPeriod` writes the period record, the vote cache and one box per snapshotted escrow,
 * all paid by the instance itself, with no registry top-up path (see seed-periods). ~1.5 ALGO covers
 * a 22-candidate period on the largest instance; the rest stays on the instance for the next one.
 */
const INSTANCE_HEADROOM_MICROALGOS = 3_000_000n

/** Box MBR: 2500 + 400 × (name + value bytes); body box names are well under the 32 assumed here. */
const boxMbr = (valueBytes: number) => 2_500n + 400n * BigInt(32 + valueBytes)
/** What the period app keeps for vote-record boxes after the bodies are paid for (~0.03 ALGO per voter). */
const VOTE_RECORD_ALLOWANCE_MICROALGOS = 3_000_000n

const randomNote = () => new Uint8Array(randomBytes(8))
const ts = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16)
const algo = (micro: bigint) => `${(Number(micro) / 1e6).toFixed(2)} ALGO`

let stepNumber = 0
const step = (label: string) => console.log(`[${++stepNumber}/6] ${label}`)

function votingWindow(now: bigint): { votingStart: bigint; votingEnd: bigint } {
  const length = VOTING_DAYS * DAY
  switch (STATE) {
    case 'active':
      return { votingStart: now - 3_600n, votingEnd: now - 3_600n + length }
    case 'upcoming':
      return { votingStart: now + 3n * DAY, votingEnd: now + 3n * DAY + length }
    case 'ended':
      return { votingStart: now - 3n * DAY - length, votingEnd: now - 3n * DAY }
  }
}

async function main() {
  step('Building the ballot from the period-15 fixture…')

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as VotingSessionFixture
  const election = buildCouncilElection(fixture)
  console.log(
    `  "${election.title}" · ${election.candidates.length} candidates for ${election.elect[0].s} seats · ` +
      `${election.body.length} chars of description`,
  )

  step(`Connecting to ${NETWORK}…`)

  const seed = readMirrorSeedFile(NETWORK)
  const algorand = writeClient(NETWORK)
  const deployerKey = algosdk.mnemonicToSecretKey(mirrorDeployerMnemonic(NETWORK, seed))
  algorand.account.setSignerFromAccount(deployerKey)
  const deployer = deployerKey.addr.toString()
  const deployerAccount = { sender: deployer, signer: algorand.account.getSigner(deployer) }

  const sdk = new GGovSDK({ algorand, registryAppId: BigInt(seed.gGovRegistryAppId), writerAccount: deployerAccount })
  const fracSdk = new FracDelegationSDK({
    algorand,
    registryAppId: BigInt(seed.fracRegistryAppId),
    writerAccount: deployerAccount,
  })

  // Only the operator may create a period or sync one; fail here rather than on the first write.
  const operator = (await sdk.registry.getGlobalState()).operator
  if (operator !== deployer) throw new Error(`Deployer ${deployer} is not the gGov registry operator (${operator})`)

  const committeeId = process.env.COMMITTEE_ID ?? seed.committeeId
  const committee = await sdk.registry.getCommitteeMetadata(committeeId)
  if (!committee) {
    throw new Error(
      `Committee ${committeeId} is not on gGov registry ${seed.gGovRegistryAppId} — the seed file may ` +
        `describe a different ${NETWORK} than the one running`,
    )
  }
  console.log(
    `  gGov ${seed.gGovRegistryAppId} · frac ${seed.fracRegistryAppId} · deployer ${deployer}\n` +
      `  committee ${committeeId} · ${num(committee.totalMembers)} members · ${num(committee.totalVotes)} votes`,
  )

  step('Finding the instances that hold the committee…')

  const instances = [...(await fracSdk.registry.getExistingInstances())].map(([numId, instance]) => ({
    numId,
    ...instance,
  }))
  const snapshots = await pMap(instances, (i) => fracSdk.getCommittee(i.numId, committeeId), {
    concurrency: CONCURRENCY,
  })
  const syncable = instances.filter((_, i) => snapshots[i] !== undefined)
  const unsynced = instances.filter((_, i) => snapshots[i] === undefined)
  console.log(
    `  ${syncable.length}/${instances.length} instances hold the committee` +
      (unsynced.length ? ` · skipping ${unsynced.map((i) => i.name).join(', ')}` : ''),
  )

  let toppedUp = 0n
  await pMap(
    syncable,
    async ({ appId, name }) => {
      const address = algosdk.getApplicationAddress(appId).toString()
      const { balance, minBalance } = await algorand.account.getInformation(address)
      const target = minBalance.microAlgo + INSTANCE_HEADROOM_MICROALGOS
      if (balance.microAlgo >= target) return
      const shortfall = target - balance.microAlgo
      await algorand.send.payment({
        sender: deployer,
        receiver: address,
        amount: microAlgos(shortfall),
        note: randomNote(),
      })
      toppedUp += shortfall
      console.log(`  ${name}: +${algo(shortfall)}`)
    },
    { concurrency: CONCURRENCY },
  )
  if (toppedUp) console.log(`  instances topped up with ${algo(toppedUp)} in total`)

  let periodId: bigint
  let votingStart: bigint
  let votingEnd: bigint
  if (PERIOD_ID !== undefined) {
    step(`Reusing period #${PERIOD_ID}…`)

    periodId = PERIOD_ID
    const period = await sdk.getPeriod(periodId)
    if (Buffer.from(period.committeeId).toString('base64') !== committeeId)
      throw new Error(`Period #${periodId} is bound to committee ${period.committeeId}, not ${committeeId}`)
    votingStart = BigInt(period.votingStart)
    votingEnd = BigInt(period.votingEnd)
    console.log(`  ${period.topics.length} topics · ${ts(votingStart)} → ${ts(votingEnd)}`)
  } else {
    step(`Creating the ${STATE} election period…`)

    const now = BigInt(Math.floor(Date.now() / 1000))
    ;({ votingStart, votingEnd } = votingWindow(now))

    // The final window goes in at creation: addTopic and setReady are gated on readiness, not the clock.
    periodId = (await sdk.registry.addPeriod({ committeeId, votingStart, votingEnd })) as bigint
    console.log(
      `  period #${periodId} · ${ts(votingStart)} → ${ts(votingEnd)} (PERIOD_ID=${periodId} resumes a failed run)`,
    )

    // The period app pays the MBR of its own body boxes, and addPeriod seeds it with only enough for a
    // small period: 22 application-sized candidate bodies need ~9 ALGO more. Paid upfront, sized from
    // the bodies, plus an allowance for the vote-record boxes the first votes will land on it.
    const periodAppAddr = algosdk.getApplicationAddress(await sdk.getPeriodAppId(periodId)).toString()
    const bodies = [
      JSON.stringify({ title: election.title, body: election.body, elect: election.elect }),
      ...election.candidates.map((c) => JSON.stringify({ title: c.name, body: c.body, e: 0 })),
    ]
    const bodyMbr = bodies.reduce((sum, body) => sum + boxMbr(Buffer.byteLength(body)), 0n)
    const funding = bodyMbr + VOTE_RECORD_ALLOWANCE_MICROALGOS
    await algorand.send.payment({
      sender: deployer,
      receiver: periodAppAddr,
      amount: microAlgos(funding),
      note: randomNote(),
    })
    console.log(`  period app funded with ${algo(funding)} (${algo(bodyMbr)} of body-box MBR)`)

    await sdk.uploadPeriodBody({
      periodId,
      body: { title: election.title, body: election.body, elect: election.elect },
    })
    console.log(`  body uploaded`)
    for (const candidate of election.candidates) {
      await sdk.addTopicWithBody({
        periodId,
        options: election.options,
        body: { title: candidate.name, body: candidate.body, e: 0 },
        note: randomNote(),
      })
      console.log(`  + ${candidate.name} (${candidate.pr}; ${candidate.affiliations.join(', ')})`)
    }
    await sdk.setReady({ periodId, ready: true })
    console.log(`  ready`)
  }
  const appId = await sdk.getPeriodAppId(periodId)
  console.log(`  period app ${appId}`)

  step(`Syncing the period onto ${syncable.length} instances…`)

  await pMap(
    syncable,
    async ({ numId, name }) => {
      await fracSdk.syncPeriod({ instanceNumId: numId, periodApp: appId })
      console.log(`  synced ${name}`)
    },
    { concurrency: CONCURRENCY },
  )

  step('Done.')

  const sections = [
    {
      label: 'PERIOD',
      rows: [
        `#${periodId} app ${appId} · ${STATE.toUpperCase()} · ${ts(votingStart)} → ${ts(votingEnd)}`,
        `"${election.title}" · ${election.candidates.length} candidates · ${election.elect[0].s} seats`,
        `committee ${committeeId}`,
      ],
    },
    {
      label: 'CANDIDATES',
      rows: election.candidates.map(
        (c, i) => `${String(i + 1).padStart(2)}. ${c.name.padEnd(24)} ${c.pr}  ${c.affiliations.join(', ')}`,
      ),
    },
    {
      label: 'SYNCED',
      rows: syncable.map(({ numId, name, numEscrows }) => `#${numId} ${name} · ${numEscrows} escrows`),
    },
    ...(unsynced.length
      ? [
          {
            label: 'NOT SYNCED',
            rows: unsynced.map(({ numId, name }) => `#${numId} ${name} · no snapshot of this committee`),
          },
        ]
      : []),
    {
      label: 'REGISTRIES',
      rows: [`gGov  ${seed.gGovRegistryAppId}`, `frac  ${seed.fracRegistryAppId}`, `deployer ${deployer}`],
    },
  ]
  printSections(`COUNCIL ELECTION PREVIEW — ${NETWORK.toUpperCase()}`, sections)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
