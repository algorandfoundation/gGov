/**
 * Replay Governance Period 15 (xGov Council Election 2025) on-chain.
 *
 * Takes the frozen API fixtures in this directory and turns them into a *playable*
 * gGov voting session: it registers a committee of synthetic voters (one per real
 * voter), opens a period with the 22 real candidate topics, then casts a ballot for
 * every synthetic voter so that the on-chain tallies reproduce the period-15 result.
 *
 * It either deploys a fresh GGovRegistry (default) or reuses an existing one
 * (REGISTRY_APP_ID), and works on localnet or any remote network via the standard
 * AlgoKit environment variables.
 *
 * Usage (from repo root):
 *   # localnet (default): deploys a fresh registry, DEPLOYER auto-funded from the dispenser
 *   npx tsx projects/common/gov-fixtures/replay-period-15.ts
 *
 *   # testnet (or any remote network) — standard AlgoKit env vars:
 *   ALGOD_SERVER=https://testnet-api.algonode.cloud ALGOD_PORT=443 \
 *   INDEXER_SERVER=https://testnet-idx.algonode.cloud INDEXER_PORT=443 \
 *   DEPLOYER_MNEMONIC="word1 word2 ... word25" \
 *   REGISTRY_APP_ID=123456 VOTERS=40 \
 *     npx tsx projects/common/gov-fixtures/replay-period-15.ts
 *
 * Environment overrides:
 *   ALGOD_SERVER / ALGOD_PORT / ALGOD_TOKEN / INDEXER_* / KMD_* …
 *                   # standard AlgoKit network config. When ALGOD_SERVER is set the script
 *                   # uses AlgorandClient.fromEnvironment(); otherwise it targets localnet.
 *   DEPLOYER_MNEMONIC=…  # the 25-word funder + registry operator/admin account. Required on
 *                   #   any non-localnet network; on localnet a DEPLOYER account is created
 *                   #   and auto-funded from the dispenser instead.
 *   REGISTRY_APP_ID=123456  # attach to an already-deployed GGovRegistry instead of deploying
 *                   #   a fresh one. The DEPLOYER account MUST be that registry's operator
 *                   #   (and admin, for setReady). A new period is added inside it.
 *   VOTERS=200      # number of synthetic voters (default: real count, 1394).
 *                   #   Scaling down keeps the per-topic percentages (largest-remainder
 *                   #   rounding to the new total) so the *result* is preserved, faster.
 *                   #   On a remote network keep this modest — each voter is a real account.
 *   VOTER_FUND=660000 # µAlgo per voter (default: just enough to clear the SDK's opcode-budget
 *                   #   pre-simulate bar and pay fees; fully reclaimed on close-out).
 *   RESET=0         # skip `algokit localnet reset` (default: 1 on localnet; always off on a
 *                   #   remote network or when reusing a registry)
 *   CONCURRENCY=24  # parallel vote submissions (default: 24 localnet / 8 remote)
 *   FUND_CONCURRENCY=8  # parallel funding / close-out groups (each group is 16 txns)
 *   CLOSEOUT=0      # skip closing the voter accounts back to the deployer at the end
 *
 * ── How the result is reproduced ──────────────────────────────────────────────
 * The real result is stake-weighted: each governor allocated their committed ALGO
 * to one of Yes / No / Abstain per candidate, and the fixture reports the outcome as
 * a *percentage of stake* per option. The gGov contract stores tallies as uint32, so
 * raw microalgo stake (~10^13) cannot be used as voting power. Instead every synthetic
 * voter is given equal voting power (1), and for each topic we split the voters across
 * the three options in the fixture's proportions (largest-remainder rounding to the
 * voter count). The resulting *count* percentages therefore match the fixture's
 * *stake* percentages — i.e. the same end result, candidate by candidate.
 *
 * Requires: a reachable network (localnet running, or ALGOD_SERVER set) and the SDKs
 * built (pnpm -w build or ggov-sdk dist present).
 *
 * Tallies are read back with sdk.getPeriod(), which uses the contract's logPeriod() —
 * one log line per topic — so it handles all 22 topics without hitting the 1024-byte
 * single-return log limit that plain getPeriod() overflows past ~21 topics.
 */

import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Resolve runtime deps from the ggov-sdk package (the fixtures dir has no node_modules
// of its own; ggov-sdk depends on algokit-utils + algosdk). The local JSON fixtures and
// the SDK dist are required by absolute path.
const sdkDir = path.resolve(__dirname, '../../ggov-sdk')
const sdkRequire = createRequire(path.join(sdkDir, 'package.json'))
const require = createRequire(import.meta.url)

// CJS dist to dodge ESM-source resolution issues (matches deploy-sample-data.ts).
const { AlgorandClient, microAlgos } = sdkRequire('@algorandfoundation/algokit-utils')
const { GGovSDK, GGovRegistrySDK } = require(path.join(sdkDir, 'dist/index.js'))
const algosdk = sdkRequire('algosdk')

const votingSession = require('./voting-session-period-15-voting-session-1.json')
const committeeTemplate = require('../committee-files/template.json')

const KMD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const LOCALNET_CONFIG = {
  algodConfig: { server: 'http://localhost', port: 4001, token: KMD_TOKEN },
  indexerConfig: { server: 'http://localhost', port: 8980, token: KMD_TOKEN },
  kmdConfig: { server: 'http://localhost', port: 4002, token: KMD_TOKEN },
}

// ── Config ──────────────────────────────────────────────────────────────────
// When ALGOD_SERVER is set we use the standard AlgoKit environment (fromEnvironment);
// otherwise we target localnet with the fixed config above.
const USE_ENV = !!process.env.ALGOD_SERVER
const REGISTRY_APP_ID = process.env.REGISTRY_APP_ID ? BigInt(process.env.REGISTRY_APP_ID) : undefined

const REAL_VOTER_COUNT = Number(votingSession.total_voted_governors_count) // 1394
const NUM_VOTERS = Number(process.env.VOTERS ?? REAL_VOTER_COUNT)
// Reset only a fresh localnet deployment — never a remote network or a reused registry.
const RESET = !USE_ENV && REGISTRY_APP_ID === undefined && process.env.RESET !== '0'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? (USE_ENV ? 8 : 24))
const FUND_CONCURRENCY = Number(process.env.FUND_CONCURRENCY ?? 8)
const CLOSEOUT = process.env.CLOSEOUT !== '0'

const GROUP_SIZE = 16 // Algorand atomic-group limit; fund / close out in groups this big.

// Per-voter funding — "just enough to transact", reclaimed by the end-of-run close-out.
// NB: the SDK's opcode-budget pre-simulate temporarily sets the first txn's fee to
// 543_210 µAlgo. Each voter votes through its own SDK (writerAccount = the voter), so the
// voter is the sender of both its vote and the prepended opcode-budget-increase txn. The
// voter must therefore hold more than the pre-sim bar (+ its 100_000 min balance) or the
// pre-simulate overspends, reports appBudgetConsumed=0, and the auto budget-increase is
// silently skipped — making the real 22-topic vote fail at the 700-opcode cap. So fund each
// voter just over that bar, plus a little headroom for the vote + budget-increase +
// close-out fees. Override with VOTER_FUND (µAlgo).
const VOTER_PRESIM_BAR_UALGO = 543_210n + 100_000n // pre-sim first-txn fee + min balance = 643_210
const VOTER_FUND_UALGO = process.env.VOTER_FUND ? BigInt(process.env.VOTER_FUND) : VOTER_PRESIM_BAR_UALGO + 16_790n // 660_000
const APP_MBR_PER_VOTER_UALGO = 220_000n // one account box (registry) / vote box (period)
const APP_MBR_BASE_UALGO = 20_000_000n // committee superbox, topic bodies, period body

function randomNote(): Uint8Array {
  return new Uint8Array(randomBytes(8))
}

/**
 * Convert the fixtures' `description_html` into Markdown for the markdown-rendering
 * frontend (react-markdown + remark-gfm). Handles exactly the HTML the period-15
 * fixtures contain: <p>, <ul>/<li>, <strong>/<b>, <em>/<i>, <a href>, <br>, and the
 * &rsquo;/&lsquo; family of entities. Unknown tags are stripped.
 */
function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let s = html
  s = s.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${txt.trim()}](${href})`)
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${txt.trim()}**`)
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${txt.trim()}*`)
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt) => `- ${txt.trim()}\n`)
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '')
  s = s.replace(/<[^>]+>/g, '') // strip any remaining tags
  const entities: Record<string, string> = {
    '&rsquo;': '’',
    '&lsquo;': '‘',
    '&ldquo;': '“',
    '&rdquo;': '”',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  }
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => entities[m] ?? m)
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Largest-remainder apportionment: split `total` into integer parts ∝ weights. */
function largestRemainder(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const exact = weights.map((w) => (w / sum) * total)
  const floors = exact.map((x) => Math.floor(x))
  let remaining = total - floors.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) out[order[k].i]++
  return out
}

/** Split `arr` into contiguous chunks of at most `n`. */
function chunk<T>(arr: T[], n: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / n) }, (_, b) => arr.slice(b * n, b * n + n))
}

/** Run `tasks` with bounded concurrency, reporting progress every `tick`. */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>, label: string) {
  let next = 0
  let done = 0
  const tick = Math.max(1, Math.floor(items.length / 20))
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i], i)
      done++
      if (done % tick === 0 || done === items.length) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  process.stdout.write('\n')
}

/**
 * Close every account in `accounts` to `to`, in parallel atomic groups of ≤16 (the max
 * transactions per group). Reclaims each account's full balance — including its locked
 * min-balance — minus the close-out fee. Per-group errors are logged, not thrown, so this
 * is safe to call from a finally without masking an earlier failure.
 */
async function closeOutAccounts(algorand: any, accounts: string[], to: string, label: string) {
  if (!accounts.length) return
  let failed = 0
  await pool(
    chunk(accounts, GROUP_SIZE),
    FUND_CONCURRENCY,
    async (group) => {
      try {
        let g = algorand.newGroup()
        for (const addr of group) {
          g = g.addPayment({ sender: addr, receiver: to, amount: microAlgos(0n), closeRemainderTo: to })
        }
        await g.send()
      } catch {
        failed += group.length
      }
    },
    label,
  )
  if (failed) console.log(`  (${failed} account(s) skipped — already empty or never funded)`)
}

async function main() {
  const topics: Array<{ title: string; body: string; options: string[]; percentages: number[] }> =
    votingSession.topics.map((t: any) => ({
      title: t.title,
      body: htmlToMarkdown(t.description_html ?? ''),
      options: t.topic_options.map((o: any) => o.title),
      percentages: t.topic_options.map((o: any) => Number(o.vote_percentage)),
    }))

  console.log('=== Replay Governance Period 15 — xGov Council Election 2025 ===')
  console.log(`Network: ${USE_ENV ? 'environment (ALGOD_SERVER)' : 'localnet'}`)
  console.log(`Registry: ${REGISTRY_APP_ID === undefined ? 'deploy fresh' : `reuse app ${REGISTRY_APP_ID}`}`)
  console.log(`Real voters: ${REAL_VOTER_COUNT}  |  synthetic voters this run: ${NUM_VOTERS}`)
  console.log(`Topics: ${topics.length} (each Yes / No / Abstain)\n`)

  // Per-topic integer voter counts per option, summing to NUM_VOTERS.
  const topicCounts = topics.map((t) => largestRemainder(t.percentages, NUM_VOTERS))

  // ── Reset & connect ─────────────────────────────────────────────────────
  if (RESET) {
    console.log('Resetting localnet...')
    execSync('algokit localnet reset', { stdio: 'inherit' })
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`Connecting (${USE_ENV ? 'fromEnvironment' : 'localnet'})...`)
  const algorand = USE_ENV ? AlgorandClient.fromEnvironment() : AlgorandClient.fromConfig(LOCALNET_CONFIG)

  // The DEPLOYER account is the single funder, registry operator/admin and setup SDK writer; it
  // pays for voter funding and app MBR, and receives every voter's close-out at the end. Each
  // voter now pays its own vote + opcode-budget-increase fees out of its VOTER_FUND balance (it
  // votes through its own SDK), so those fees still trace back to the deployer via that funding.
  // On a remote network the deployer comes from DEPLOYER_MNEMONIC; on localnet it is created and
  // auto-funded from the dispenser.
  const totalNeeded =
    BigInt(NUM_VOTERS) * VOTER_FUND_UALGO + // voter accounts (cover their own vote + budget-increase fees)
    2n * (BigInt(NUM_VOTERS) * APP_MBR_PER_VOTER_UALGO + APP_MBR_BASE_UALGO) + // registry + period boxes
    BigInt(Math.ceil(NUM_VOTERS * 0.06) + 30) * 1_000_000n + // working headroom (voters self-pay budget-increase)
    50_000_000n // working buffer + own min balance

  const deployer = await algorand.account.fromEnvironment('DEPLOYER', microAlgos(totalNeeded))
  algorand.account.setSignerFromAccount(deployer)
  const deployerStr = deployer.addr.toString()
  const writer = { sender: deployer.addr, signer: algorand.account.getSigner(deployer.addr) }
  console.log(`Deployer / funder: ${deployerStr}`)

  const deployerInfo = await algorand.account.getInformation(deployer.addr)
  if (BigInt(deployerInfo.balance.microAlgo) < totalNeeded) {
    throw new Error(
      `Deployer ${deployerStr} balance ${deployerInfo.balance.microAlgo} < required ~${totalNeeded} µAlgo. ` +
        (USE_ENV ? 'Lower VOTERS or top up DEPLOYER (faucet).' : 'Lower VOTERS or top up the localnet dispenser.'),
    )
  }

  // Created accounts tracked for end-of-run close-out (reclaim funds → deployer).
  let voters: string[] = []
  try {
    // ── Registry: deploy fresh, or attach to an existing deployment ─────────
    let sdk: any
    let registryAppId: bigint
    let registryAppAddr: string
    if (REGISTRY_APP_ID === undefined) {
      console.log('Deploying GGovRegistry...')
      const created = await GGovRegistrySDK.createRegistry({
        algorand,
        deployer: writer,
        operatorAccount: deployer.addr,
        initialFundingAlgos: 10n,
      })
      registryAppId = created.appClient.appId
      registryAppAddr = created.appClient.appAddress.toString()
      // Combined SDK for period ops; registry ops go through sdk.registry.
      sdk = new GGovSDK({ algorand, registryAppId, writerAccount: writer })
    } else {
      console.log(`Attaching to existing GGovRegistry app ${REGISTRY_APP_ID}...`)
      // The DEPLOYER must already be this registry's operator (and admin for setReady).
      sdk = new GGovSDK({ algorand, registryAppId: REGISTRY_APP_ID, writerAccount: writer })
      registryAppId = REGISTRY_APP_ID
      registryAppAddr = algosdk.getApplicationAddress(REGISTRY_APP_ID).toString()
    }
    console.log(`  Registry app ID: ${registryAppId}`)

    // Top up the registry app for the committee superbox + per-account boxes this run creates.
    const registryTopUp = BigInt(NUM_VOTERS) * APP_MBR_PER_VOTER_UALGO + APP_MBR_BASE_UALGO
    await algorand.send.payment({
      sender: deployer.addr,
      receiver: registryAppAddr,
      amount: microAlgos(registryTopUp),
    })

    // ── Synthetic voters ──────────────────────────────────────────────────
    console.log(`\nGenerating ${NUM_VOTERS} synthetic voter accounts...`)
    voters = Array.from({ length: NUM_VOTERS }, () => {
      const acct = algorand.account.random()
      algorand.account.setSignerFromAccount(acct)
      return acct.addr.toString()
    })

    console.log(
      `Funding voters (${VOTER_FUND_UALGO} µAlgo each, groups of ${GROUP_SIZE}, ${FUND_CONCURRENCY} parallel)...`,
    )
    await pool(
      chunk(voters, GROUP_SIZE),
      FUND_CONCURRENCY,
      async (batch) => {
        let group = algorand.newGroup()
        for (const addr of batch) {
          group = group.addPayment({ sender: deployer.addr, receiver: addr, amount: microAlgos(VOTER_FUND_UALGO) })
        }
        await group.send()
      },
      'funded',
    )

    // ── Committee file (1 vote of power each) ───────────────────────────────
    console.log('\nUploading committee (synthetic voters as govs, 1 vote each)...')
    const committeeFile = {
      ...committeeTemplate,
      totalMembers: voters.length,
      totalVotes: voters.length,
      registryId: 0,
      govs: voters.map((address) => ({ address, votes: 1 })),
    }
    const committeeId = await sdk.registry.uploadCommitteeFile(committeeFile)
    const committeeHex = Buffer.from(committeeId as Uint8Array).toString('hex')
    console.log(`  Committee ID: ${committeeHex.slice(0, 16)}...`)

    // ── Period + topics ─────────────────────────────────────────────────────
    const now = BigInt(Math.floor(Date.now() / 1000))
    console.log('\nCreating period (future window so topics can be added)...')
    const periodId = await sdk.registry.addPeriod({
      committeeId,
      votingStart: now + 100_000n,
      votingEnd: now + 200_000n,
    })
    console.log(`  Period #${periodId}`)

    await sdk.uploadPeriodBody({
      periodId: periodId!,
      body: {
        title: votingSession.short_description || votingSession.title,
        body: htmlToMarkdown(votingSession.description_html || ''),
      },
    })

    // Pre-fund the period app for the per-voter vote-record boxes.
    const periodAppId = await sdk.getPeriodAppId(periodId!)
    const periodAppAddr = algosdk.getApplicationAddress(periodAppId).toString()
    const periodTopUp = BigInt(NUM_VOTERS) * APP_MBR_PER_VOTER_UALGO + APP_MBR_BASE_UALGO
    await algorand.send.payment({
      sender: deployer.addr,
      receiver: periodAppAddr,
      amount: microAlgos(periodTopUp),
    })

    console.log(`Adding ${topics.length} candidate topics...`)
    for (let t = 0; t < topics.length; t++) {
      const topicIndex = await sdk.addTopic({
        periodId: periodId!,
        options: topics[t].options,
        note: randomNote(),
      })
      await sdk.uploadTopicBody({
        periodId: periodId!,
        topicIndex: topicIndex!,
        body: { title: topics[t].title, body: topics[t].body },
      })
      process.stdout.write(`\r  topic ${t + 1}/${topics.length}: ${topics[t].title.padEnd(28)}`)
    }
    process.stdout.write('\n')

    // Open voting now, mark ready.
    await sdk.editPeriod({
      periodId: periodId!,
      committeeId,
      votingStart: now - 600n,
      votingEnd: now + 86_400n,
    })
    await sdk.setReady({ periodId: periodId!, ready: true })
    console.log('Period is ACTIVE and ready for voting.')

    // ── Build ballots ───────────────────────────────────────────────────────
    // ballots[voter][topic] = one-hot [Yes,No,Abstain] (power 1). Per topic we assign
    // voters to options in contiguous blocks (rotated per topic) to hit the exact counts.
    const ballots: number[][][] = voters.map(() => topics.map(() => [0, 0, 0]))
    for (let t = 0; t < topics.length; t++) {
      const [cy, cn] = topicCounts[t]
      const rot = (t * 257) % NUM_VOTERS
      for (let k = 0; k < NUM_VOTERS; k++) {
        const v = (k + rot) % NUM_VOTERS
        const opt = k < cy ? 0 : k < cy + cn ? 1 : 2
        ballots[v][t][opt] = 1
      }
    }

    // ── Cast votes ──────────────────────────────────────────────────────────
    // Each voter votes through its own SDK (writerAccount = the voter), so the voter is the
    // sender of both its vote and the auto-prepended opcode-budget-increase txn. Per-voter
    // instances are concurrency-safe (no shared mutable writerAccount); the period-app-id cache
    // is primed so each instance skips an otherwise-redundant getPeriodApp read.
    console.log(`\nCasting ${NUM_VOTERS} ballots (concurrency ${CONCURRENCY})...`)
    await pool(
      voters,
      CONCURRENCY,
      async (addr, i) => {
        const voterSdk = new GGovSDK({
          algorand,
          registryAppId: registryAppId,
          writerAccount: { sender: addr, signer: algorand.account.getSigner(addr) },
        })
        ;(voterSdk as any).periodAppCache.set(BigInt(periodId!), BigInt(periodAppId))
        await voterSdk.vote({
          periodId: periodId!,
          voterAccount: addr,
          topicVotes: ballots[i],
          note: randomNote(),
        })
      },
      'voted',
    )

    // ── Verify ──────────────────────────────────────────────────────────────
    // Read tallies via sdk.getPeriod(), which now uses the contract's logPeriod (one log
    // line per topic) and so handles all 22 topics without hitting the 1024-byte log limit.
    console.log('\nReading back on-chain tallies...\n')
    const period = await sdk.getPeriod(periodId!)
    const tallies: number[][] = period.topics.map((t: [string[], number[]]) => t[1])

    let allMatch = true
    console.log('Candidate                      On-chain (Y/N/A)        chain%  fixture%   ✓')
    console.log('─'.repeat(86))
    for (let t = 0; t < topics.length; t++) {
      const tally = tallies[t]
      const total = tally.reduce((a, b) => a + b, 0) || 1
      const chainPct = tally.map((n) => ((n / total) * 100).toFixed(2))
      const expected = topicCounts[t]
      const ok = tally.every((n, j) => n === expected[j])
      allMatch = allMatch && ok
      const yChain = `${chainPct[0]}/${chainPct[1]}/${chainPct[2]}`
      const yFix = topics[t].percentages.map((p) => p.toFixed(2)).join('/')
      console.log(
        `${topics[t].title.padEnd(28)} ${`${tally[0]}/${tally[1]}/${tally[2]}`.padEnd(22)} ` +
          `${yChain.padEnd(20)} ${yFix.padEnd(18)} ${ok ? '✓' : '✗'}`,
      )
    }
    console.log('─'.repeat(86))

    console.log('\n=== Summary ===')
    console.log(`Registry app:  ${registryAppId}`)
    console.log(`Period app:    ${periodAppId}  (period #${periodId})`)
    console.log(`Voters:        ${NUM_VOTERS} (1 vote each)`)
    console.log(`Tallies match fixture proportions: ${allMatch ? 'YES ✓' : 'NO ✗'}`)
    if (!allMatch) process.exitCode = 1
  } finally {
    // Reclaim every funded voter account back to the deployer (matters most on a remote
    // network, where the ALGO is real). Runs even if the replay threw partway, so a failed
    // run still cleans up. The deployer is the persistent funder and is left as-is.
    if (CLOSEOUT && voters.length) {
      console.log(`\nClosing out ${voters.length} voter accounts to the deployer...`)
      const before = BigInt((await algorand.account.getInformation(deployer.addr)).balance.microAlgo)
      await closeOutAccounts(algorand, voters, deployerStr, 'closed')
      const after = BigInt((await algorand.account.getInformation(deployer.addr)).balance.microAlgo)
      console.log(`  Reclaimed ~${after - before} µAlgo to ${deployerStr}`)
      console.log('Note: app-account MBR (registry + period boxes) stays locked until the apps are deleted.')
    }
  }
}

main().catch((err) => {
  console.error('\nError:', err)
  process.exit(1)
})
