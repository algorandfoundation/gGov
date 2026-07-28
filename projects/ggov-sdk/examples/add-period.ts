/**
 * Smoke test for the ggov-sdk's addPeriod factory flow on localnet.
 *
 * Usage:
 *   cd projects/ggov-sdk
 *   npx tsx examples/add-period.ts ../common/committee-files/2048.json
 *
 *   # Council election: set ELECT_SEATS to the number of seats being elected.
 *   ELECT_SEATS=3 npx tsx examples/add-period.ts ../common/committee-files/2048.json
 *
 * Steps:
 *   1. GGovSDK.createRegistry() — deploys registry, seeds MBR, uploads period approval
 *      bytecode, sets the operator (= deployer for convenience) in one call
 *   2. uploadCommitteeFile (committee must be complete before addPeriod)
 *   3. addPeriod (creates a child GGovPeriod app via inner txn)
 *   4. uploadPeriodBody — title + description, plus `elect` (one `{ t, s }` entry per election)
 *      for a council election; the presence of `elect` is what marks the period as an election
 *   5. addTopic (+ uploadTopicBody) — one Support/Against/Abstain ballot per candidate for an election
 *      (the candidate handle is the topic title, `e` is the index of the election it runs in),
 *      otherwise a single topic
 *   6. getPeriod (reads from the per-period app)
 *   7. getPeriodSummary (reads from the registry)
 */
import { readFileSync } from 'fs'
import { GGovSDK } from '..'
import { getAlgorand } from './env'

/**
 * Optional `ELECT_SEATS` env var: a positive integer = the number of seats being
 * elected, which marks the period as a council election. Unset = a standard vote.
 */
function parseElectSeats(): number | undefined {
  const raw = process.env.ELECT_SEATS?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ELECT_SEATS "${process.env.ELECT_SEATS}": expected a whole number of seats (1 or more).`)
  }
  return n
}

void (async () => {
  const file = JSON.parse(readFileSync(process.argv[2], 'utf-8'))
  const seats = parseElectSeats()
  const isElection = seats !== undefined
  // One council election here, but `elect` is a list: a period can run several races side by
  // side, and each candidate joins one by carrying that election's index in its own `e`.
  const elect = isElection ? [{ t: 'Council', s: seats }] : undefined

  const algorand = getAlgorand()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  // 1. Deploy fresh GGovRegistry + seed MBR + upload period approval bytecode + setOperator.
  const { sdk, appClient } = await GGovSDK.createRegistry({
    algorand,
    deployer: { sender: deployer.addr, signer: deployer.signer },
    operatorAccount: deployer.addr.toString(),
  })
  console.log('Registry app:', appClient.appId, 'operator set to deployer')

  // 2. uploadCommitteeFile
  const committeeId = await sdk.uploadCommitteeFile(file)
  console.log('Committee uploaded:', Buffer.from(committeeId).toString('base64'))

  // 3. addPeriod
  const now = BigInt(Math.floor(Date.now() / 1000))
  const periodId = await sdk.addPeriod({
    committeeId,
    votingStart: now + 60n,
    votingEnd: now + 3600n,
  })
  console.log('Period created, periodId:', periodId)

  // 4. uploadPeriodBody — the `elect` body field (one entry per election) marks a council election; omit it for a standard vote.
  await sdk.uploadPeriodBody({
    periodId,
    body: {
      title: isElection ? 'gGov Council — Term 2 election' : 'Protocol parameter review',
      body: isElection
        ? `Elect ${seats} council member${seats === 1 ? '' : 's'}. Each candidate below is a Support/Against/Abstain ballot; candidates are ranked by net score (Support − Against) and the top ${seats} lead for the available seats.`
        : 'A standard governance vote on the proposed change.',
      ...(elect ? { elect } : {}),
    },
  })
  console.log(
    isElection ? `Period body uploaded (council election, ${seats} seats)` : 'Period body uploaded (standard vote)',
  )

  // 5. addTopic. For an election, one Support/Against/Abstain ballot per candidate — one more
  // than the seat count, so at least one candidate sits below the cutoff — with the candidate
  // handle as the topic title and `e: 0` entering it in the sole election. Otherwise, a single topic.
  if (isElection) {
    const candidateCount = seats + 1
    for (let i = 0; i < candidateCount; i++) {
      const topicIndex = await sdk.addTopic({ periodId, options: ['Support', 'Against', 'Abstain'] })
      await sdk.uploadTopicBody({
        periodId,
        topicIndex,
        body: { title: `candidate-${i + 1}.algo`, body: `Candidate ${i + 1} for the council.`, e: 0 },
      })
      console.log(`Candidate topic added, index: ${topicIndex} (candidate-${i + 1}.algo)`)
    }
  } else {
    const topicIndex = await sdk.addTopic({ periodId, options: ['Yes', 'No', 'Abstain'] })
    console.log('Topic added, index:', topicIndex)
  }

  // 6. getPeriod (reads from per-period app)
  const period = await sdk.getPeriod(periodId)
  console.log('Period detail:', {
    votingStart: period.votingStart,
    votingEnd: period.votingEnd,
    topics: period.topics.length,
    elect: elect?.map((election) => `${election.t} (${election.s} seats)`) ?? '(standard vote)',
  })

  // 7. getPeriodSummary (reads from registry)
  const { return: summary } = await sdk.registry.readClient.send.getPeriodSummary({
    args: { periodId },
  })
  console.log('Registry summary:', {
    appId: summary!.appId,
    votingStart: summary!.votingStart,
    votingEnd: summary!.votingEnd,
    numTopics: summary!.numTopics,
  })
})()
