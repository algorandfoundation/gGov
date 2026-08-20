/**
 * On-chain verification for the registry's `logInstanceCommittees` / `getInstanceCommittee` and the
 * instance's `getCommitteeStanding` that back them.
 *
 * The real coverage is `fracDelegationRegistry.instanceCommittees.e2e.spec.ts`. This script exists
 * because the contracts vitest e2e harness is, at time of writing, broken environment-side — every
 * e2e spec dies in algokit's composer with `Not an address: <a valid address>`, on an untouched
 * checkout as much as this branch (see the note in the e2e-prereqs memory). Until that is fixed
 * this is the only way to actually exercise these methods against a chain.
 *
 * Drives the built SDKs, so it covers the same path the frontend takes. Deploys its own registries
 * rather than reusing whatever is on LocalNet, so it leaves existing state alone.
 *
 *   pnpm exec tsx scripts/verify-instance-committees.ts
 *
 * Requires LocalNet running and both SDKs built (`pnpm --filter ggov-sdk build`,
 * `pnpm --filter frac-delegation-sdk build`).
 */
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlgorandClient, algo } from '@algorandfoundation/algokit-utils'
import type { GGovCommitteeFile } from 'ggov-sdk'
import type { AlgoQuartersFile } from 'frac-delegation-sdk'

const require = createRequire(import.meta.url)
// The SDKs' package `main` is `dist/`, so require the build directly — this script
// runs from `projects/contracts`, which does not depend on either.
const PROJECTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { GGovSDK, GGovRegistrySDK } = require(`${PROJECTS}/ggov-sdk/dist/index.js`) as typeof import('ggov-sdk')
const { FracDelegationSDK, FracDelegationRegistrySDK } = require(
  `${PROJECTS}/frac-delegation-sdk/dist/index.js`,
) as typeof import('frac-delegation-sdk')

let failures = 0
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
function check(label: string, actual: unknown, expected: unknown) {
  const ok = show(actual) === show(expected)
  if (!ok) failures++
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      expected ${show(expected)}\n      actual   ${show(actual)}`}`,
  )
}

async function main() {
  const algorand = AlgorandClient.defaultLocalNet()
  const dispenser = await algorand.account.localNetDispenser()

  const deployer = algorand.account.random()
  await algorand.send.payment({ sender: dispenser.addr, receiver: deployer.addr, amount: algo(200) })
  const deployerAccount = { sender: deployer.addr, signer: algorand.account.getSigner(deployer.addr) }

  console.log('Deploying registries…')
  const { appClient: gGovRegistryApp } = await GGovRegistrySDK.createRegistry({
    algorand,
    deployer: deployerAccount,
    operatorAccount: deployer.addr,
    initialFundingAlgos: 50n,
  })
  const { appClient: fracRegistryApp } = await FracDelegationRegistrySDK.createRegistry({
    algorand,
    deployer: deployerAccount,
    defaultOperatorAccount: deployer.addr,
    gGovRegistryAppId: gGovRegistryApp.appId,
    initialFundingAlgos: 50n,
  })
  const sdk = new GGovSDK({ algorand, registryAppId: gGovRegistryApp.appId, writerAccount: deployerAccount })
  const fracSdk = new FracDelegationSDK({
    algorand,
    registryAppId: fracRegistryApp.appId,
    writerAccount: deployerAccount,
  })
  await sdk.registry.setFracRegistryApp({ appId: fracRegistryApp.appId })

  // ── Committee: 4 govs, 10 votes each. Three of them become escrows.
  console.log('Uploading committee file…')
  const govs = Array.from({ length: 4 }, () => algorand.account.random())
  for (const g of govs) await algorand.send.payment({ sender: dispenser.addr, receiver: g.addr, amount: algo(1) })
  const network = await algorand.client.network()
  const committeeFile: GGovCommitteeFile = {
    networkGenesisHash: network.genesisHash!,
    periodStart: 50_000_000,
    periodEnd: 53_000_000,
    registryId: Number(gGovRegistryApp.appId),
    totalMembers: govs.length,
    totalVotes: govs.length * 10,
    govs: govs.map((g) => ({ address: g.addr.toString(), votes: 10 })),
  }
  const committeeId = (await sdk.registry.uploadCommitteeFile(committeeFile)) as Uint8Array

  // ── Three instances covering the three reportable states.
  console.log('Creating instances…')
  const withLedgerId = await fracSdk.registry.addInstance({ name: 'pool-with-ledger' })
  const syncedOnlyId = await fracSdk.registry.addInstance({ name: 'pool-synced-only' })
  const unsyncedId = await fracSdk.registry.addInstance({ name: 'pool-unsynced' })

  for (const account of [govs[0].addr.toString(), govs[1].addr.toString()]) {
    await fracSdk.registry.registerEscrow({ instanceNumId: withLedgerId, account })
  }
  await fracSdk.registry.registerEscrow({ instanceNumId: syncedOnlyId, account: govs[2].addr.toString() })

  await fracSdk.syncCommittee({ instanceNumId: withLedgerId, committeeId })
  await fracSdk.syncCommittee({ instanceNumId: syncedOnlyId, committeeId })

  console.log('Ingesting AlgoQuarters on pool-with-ledger…')
  const aqAccounts = Array.from({ length: 3 }, () => algorand.account.random())
  const aqFile: AlgoQuartersFile = {
    networkGenesisHash: network.genesisHash!,
    protocol: 'reti',
    periodStart: 50_000_000,
    periodEnd: 53_000_000,
    totalAccounts: 3,
    totalAlgoQuarters: '300',
    accounts: aqAccounts.map((a) => ({ account: a.addr.toString(), algoQuarters: '100' })),
  }
  await fracSdk.uploadAqFile({ instanceNumId: withLedgerId, committeeId, aqFile })

  const reader = fracSdk.registry

  // ── 1. Every instance reported, with identity + snapshot + ledger joined.
  console.log('\n1. getInstanceCommitteeStandings — all three states')
  const standings = await reader.getInstanceCommitteeStandings(committeeId)
  check('three records', standings.length, 3)
  check(
    'ascending by instanceNumId',
    standings.map((s) => s.instanceNumId),
    [Number(withLedgerId), Number(syncedOnlyId), Number(unsyncedId)],
  )
  const by = new Map(standings.map((s) => [s.instanceNumId, s]))
  const a = by.get(Number(withLedgerId))!
  check('withLedger name', a.instanceName, 'pool-with-ledger')
  check('withLedger appId', a.instanceAppId, await fracSdk.getInstanceAppId(withLedgerId))
  check('withLedger committeeNumId', a.committeeNumId, 1)
  check('withLedger totalVotes (2 escrows x 10)', a.totalVotes, 20)
  check('withLedger totalAq', a.totalAq, 300)
  check('withLedger ingestedAq', a.ingestedAq, 300)
  check('withLedger totalAccounts', a.totalAccounts, 3)
  check('withLedger numAccounts', a.numAccounts, 3)
  check('withLedger instanceNumAccounts (roster)', Number(a.instanceNumAccounts), 3)

  const b = by.get(Number(syncedOnlyId))!
  check('syncedOnly totalVotes', b.totalVotes, 10)
  check('syncedOnly committeeNumId (synced)', b.committeeNumId, 1)
  check('syncedOnly totalAq (no ledger)', b.totalAq, 0)
  check('syncedOnly numAccounts', b.numAccounts, 0)

  const c = by.get(Number(unsyncedId))!
  check('unsynced committeeNumId sentinel', c.committeeNumId, 0)
  check('unsynced totalVotes', c.totalVotes, 0)
  check('unsynced name still reported', c.instanceName, 'pool-unsynced')

  // ── 2. Roster vs window-scoped account counts diverge.
  console.log('\n2. instanceNumAccounts is the roster, numAccounts is the window')
  const extra = algorand.account.random()
  await fracSdk.registry.writeClient!.send.getOrCreateAccountWithInstance({
    args: { account: extra.addr.toString(), instanceNumId: withLedgerId },
  })
  const after = new Map((await reader.getInstanceCommitteeStandings(committeeId)).map((s) => [s.instanceNumId, s])).get(
    Number(withLedgerId),
  )!
  check('roster grew', Number(after.instanceNumAccounts), 4)
  check('window count did not', after.numAccounts, 3)

  // ── 3. Paging.
  console.log('\n3. paging over the instance range')
  reader.instanceCommitteesPageSize = 1
  const paged = await reader.getInstanceCommitteeStandings(committeeId)
  check(
    'same set one instance per page',
    show(paged),
    show(
      await (async () => {
        reader.instanceCommitteesPageSize = 32
        return reader.getInstanceCommitteeStandings(committeeId)
      })(),
    ),
  )

  // ── 4. Singular getter agrees with the paged record.
  console.log('\n4. getInstanceCommittee (singular)')
  const one = await reader.getInstanceCommittee(withLedgerId, committeeId)
  check('matches the logged record', show(one), show(after))
  let threw = ''
  try {
    await reader.getInstanceCommittee(999, committeeId)
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check('unknown instance throws I_NX', /I_NX|does not exist/.test(threw), true)

  // ── 5. Instance-side join.
  console.log('\n5. getCommitteeStanding (instance)')
  const standing = (await fracSdk.getCommitteeStanding(withLedgerId, committeeId))!
  const committee = (await fracSdk.getCommittee(withLedgerId, committeeId))!
  const aq = (await fracSdk.getCommitteeAq(withLedgerId, committee.committeeNumId))!
  check('committeeNumId matches getCommittee', standing.committeeNumId, committee.committeeNumId)
  check('totalVotes matches getCommittee', standing.totalVotes, committee.totalVotes)
  check('totalAq matches getCommitteeAq', standing.totalAq, aq.totalAq)
  check('numAccounts matches getCommitteeAq', standing.numAccounts, aq.numAccounts)
  check('unsynced instance -> undefined', await fracSdk.getCommitteeStanding(unsyncedId, committeeId), undefined)

  // ── 6. A deleted instance app drops out instead of failing the page.
  console.log('\n6. deleted instance app is skipped')
  await fracSdk.deleteInstanceApp({ instanceNumId: syncedOnlyId })
  const afterDelete = await reader.getInstanceCommitteeStandings(committeeId)
  check(
    'deleted instance absent, others intact',
    afterDelete.map((s) => s.instanceNumId),
    [Number(withLedgerId), Number(unsyncedId)],
  )
  check('survivor still correct', afterDelete[0].totalVotes, 20)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
