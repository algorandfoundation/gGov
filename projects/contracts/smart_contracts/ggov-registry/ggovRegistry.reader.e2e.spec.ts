import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { GGovCommitteeFile } from 'ggov-sdk'
import { errAccountNotExists, errCommitteeIncomplete, errCommitteeNotExists } from '../base/errors.algo'
import {
  createSDK,
  deployRegistry,
  deployRegistryWithCommittee,
  deployRegistryWithTwoCommittees,
  transformedError,
} from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
import { configureTestLogging } from '../test-utils'

describe('GGovRegistry readers', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  // GGov Accounts
  describe('getAccount', () => {
    test('getAccount returns GGovAccount with committeeOffsets after ingestion', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet)

      for (const gov of govAccounts) {
        const { return: registryAccount } = await sdk.readClient.send.getAccount({
          args: { account: gov.toString() },
        })
        expect(registryAccount).toBeDefined()
        expect(registryAccount!.accountId).toBeGreaterThan(0)
        // should have exactly one committee offset entry
        expect(registryAccount!.committeeOffsets).toHaveLength(1)
        // committee numericId should be 1 (first committee; ids start at 1, 0 means "none")
        expect(registryAccount!.committeeOffsets[0][0]).toBe(1)
      }
    })

    test('getAccount returns zero accountId for unknown account', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { return: registryAccount } = await sdk.readClient.send.getAccount({
        args: { account: randomAccount.toString() },
      })
      expect(registryAccount).toBeDefined()
      expect(registryAccount!.accountId).toBe(0)
      expect(registryAccount!.committeeOffsets).toHaveLength(0)
    })

    test('account in two committees has two committeeOffsets', async () => {
      const { sdk, accountB } = await deployRegistryWithTwoCommittees(localnet)

      const { return: registryAccount } = await sdk.readClient.send.getAccount({
        args: { account: accountB.toString() },
      })
      expect(registryAccount).toBeDefined()
      expect(registryAccount!.accountId).toBeGreaterThan(0)
      expect(registryAccount!.committeeOffsets).toHaveLength(2)

      // numericId 1 = first committee, numericId 2 = second committee
      const numericIds = registryAccount!.committeeOffsets.map(([cId]) => cId).sort()
      expect(numericIds).toEqual([1, 2])
    })
  })

  // Contract read methods
  describe('read methods', () => {
    test('getCommitteeSuperboxMeta returns correct data after ingestion', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const numGovs = 3
      const govAccounts = await Promise.all(
        Array.from({ length: numGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: numGovs,
        totalVotes: numGovs * 10,
        registryId: 0,
        govs: govAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      const sbMeta = await sdk.getCommitteeSuperboxMeta(committeeId)
      expect(sbMeta).toBeDefined()
      // each gov is stored as (uint32, uint32) = 8 bytes
      expect(Number(sbMeta.totalByteLength)).toBe(numGovs * 8)
      expect(Number(sbMeta.valueSize)).toBe(8)
    })

    test('getCommitteeMetadata with mustBeComplete=true fails on partial committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 2,
        totalVotes: 20,
        xGovRegistryId: 0n,
      })
      // only register, don't ingest — committee is incomplete
      await expect(
        sdk.readClient.send.getCommitteeMetadata({
          args: { committeeId, mustBeComplete: true },
        }),
      ).rejects.toThrow(transformedError(errCommitteeIncomplete))
    })

    test('getCommitteeMetadata with mustBeComplete=false succeeds on partial committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 2,
        totalVotes: 20,
        xGovRegistryId: 0n,
      })
      const metadata = await sdk.getCommitteeMetadata(committeeId, false)
      expect(metadata).toBeDefined()
      expect(metadata!.totalMembers).toBe(2)
      expect(metadata!.ingestedVotes).toBe(0)
    })

    test('getCommitteeMetadata returns null for nonexistent committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const metadata = await sdk.getCommitteeMetadata(new Uint8Array(32))
      expect(metadata).toBeNull()
    })

    test('getGovVotingPower returns correct votes without offset hint', async () => {
      const { sdk, committeeId, committeeFile, govAccounts } = await deployRegistryWithCommittee(localnet)
      for (const gov of govAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getGovVotingPower({
          args: { committeeId, account: gov.toString() },
        })
        const expectedVotes = committeeFile.govs.find((x) => x.address === gov.toString())!.votes
        expect(votingPower).toBe(expectedVotes)
      }
    })

    test('getGovVotingPower fails for non-member account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        sdk.readClient.send.getGovVotingPower({
          args: { committeeId, account: randomAccount.toString() },
        }),
      ).rejects.toThrow(transformedError(errAccountNotExists))
    })

    test('tryGetGovVotingPower returns correct votes for a committee member', async () => {
      const { sdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
      const { return: power } = await sdk.readClient.send.tryGetGovVotingPower({
        args: { committeeId, account: govAccounts[0].toString() },
      })
      expect(power).toBe(10)
    })

    test('tryGetGovVotingPower returns 0 for an unknown account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { return: power } = await sdk.readClient.send.tryGetGovVotingPower({
        args: { committeeId, account: unknown.toString() },
      })
      expect(power).toBe(0)
    })

    test('tryGetGovVotingPower returns 0 for an unknown committee', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet)
      const { return: power } = await sdk.readClient.send.tryGetGovVotingPower({
        args: { committeeId: new Uint8Array(32), account: govAccounts[0].toString() },
      })
      expect(power).toBe(0)
    })

    test('getDelegation returns delegatee and exists=true after setVotingAccount', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      const { delegatee, exists } = await sdk.getDelegation(gov.toString())
      expect(delegatee).toBe(votingAddress.toString())
      expect(exists).toBe(true)
    })

    test('getDelegation returns exists=false for undelegated account', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const { exists } = await sdk.getDelegation(govAccounts[0].toString())
      expect(exists).toBe(false)
    })

    test('getDelegate returns the delegatee address after setVotingAccount', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      const { return: delegate } = await sdk.readClient.send.getDelegate({ args: { account: gov.toString() } })
      expect(delegate).toBe(votingAddress.toString())
    })

    test('getDelegate returns zero address for account with no delegation', async () => {
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const { return: delegate } = await sdk.readClient.send.getDelegate({
        args: { account: govAccounts[0].toString() },
      })
      expect(delegate).toBe(ALGORAND_ZERO_ADDRESS_STRING)
    })

    test('getPeriodSummary returns correct fields after addPeriod', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: localnet.context.testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const votingStart = now + 100n
      const votingEnd = now + 3700n
      const periodId = await sdk.addPeriod({ committeeId, votingStart, votingEnd })
      const { return: summary } = await sdk.readClient.send.getPeriodSummary({ args: { periodId } })
      expect(summary!.appId).toBeGreaterThan(0n)
      expect(summary!.votingStart).toBe(Number(votingStart))
      expect(summary!.votingEnd).toBe(Number(votingEnd))
      expect(summary!.numTopics).toBe(0)
      expect(summary!.ready).toBe(false)
    })

    test('getPeriodSummary returns zero struct for non-existent period', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const { return: summary } = await sdk.readClient.send.getPeriodSummary({ args: { periodId: 99n } })
      expect(summary!.appId).toBe(0n)
      expect(summary!.ready).toBe(false)
    })

    test('getPeriodApp returns the period app id after addPeriod', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: localnet.context.testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const { return: appId } = await sdk.readClient.send.getPeriodApp({ args: { periodId } })
      expect(appId).toBeGreaterThan(0n)
    })
  })

  // Batch reader wrappers
  describe('SDK reader wrappers', () => {
    test('getGGovAccountsMap returns accountId > 0 for known accounts and 0 for unknown', async () => {
      // logAccounts wrapper: batch-fetches GGovAccount structs via simulate, decodes ABI-encoded log bytes
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const allAddresses = [...govAccounts.map((a) => a.toString()), unknown.toString()]
      const accountsMap = await sdk.getGGovAccountsMap(allAddresses)
      for (const gov of govAccounts) {
        expect(accountsMap.get(gov.toString())!.accountId).toBeGreaterThan(0)
        expect(accountsMap.get(gov.toString())!.committeeOffsets).toHaveLength(1)
      }
      expect(accountsMap.get(unknown.toString())!.accountId).toBe(0)
      expect(accountsMap.get(unknown.toString())!.committeeOffsets).toHaveLength(0)
    })

    test('getDelegators returns all delegators for the same delegatee', async () => {
      // logDelegators wrapper: simulates log call, decodes one address per log line
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator1, delegator2] = govAccounts
      const sharedDelegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, delegator1).setVotingAccount({ votingAddress: sharedDelegatee.toString() })
      await createSDK(localnet, sdk.appId, delegator2).setVotingAccount({ votingAddress: sharedDelegatee.toString() })
      const delegators = await sdk.getDelegators(sharedDelegatee.toString())
      expect(delegators).toHaveLength(2)
      expect(delegators).toEqual(expect.arrayContaining([delegator1.toString(), delegator2.toString()]))
    })

    test('getDelegators returns empty list for account with no delegators', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      expect(await sdk.getDelegators(govAccounts[0].toString())).toEqual([])
    })

    test('getDelegations returns delegatee per account, zero address for undelegated', async () => {
      // logDelegations wrapper: batch forward lookup, order-preserving
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegated, undelegated] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, delegated).setVotingAccount({ votingAddress: votingAddress.toString() })
      const results = await sdk.getDelegations([delegated.toString(), undelegated.toString()])
      expect(results).toEqual([votingAddress.toString(), ALGORAND_ZERO_ADDRESS_STRING])
    })

    test('getCommitteesMetadata returns metadata for known committees and null for unknown', async () => {
      // logCommitteeMetadata wrapper: chunked batch fetch, decodes CommitteeMetadata structs
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const results = await sdk.getCommitteesMetadata([committeeId, new Uint8Array(32)])
      expect(results[0]).not.toBeNull()
      expect(results[0]!.totalMembers).toBeGreaterThan(0)
      expect(results[1]).toBeNull()
    })

    test('getPeriodSummaries returns summaries for known and zero struct for unknown period', async () => {
      // logPeriodSummaries wrapper: decodes GGovPeriodSummary structs from log bytes
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const summaries = await sdk.getPeriodSummaries([periodId, 99n])
      expect(summaries[0].appId).toBeGreaterThan(0n)
      expect(summaries[1].appId).toBe(0n)
    })

    test('fastGetCommittee returns the same committee data as getCommittee', async () => {
      // logCommitteePages wrapper: parallel simulate calls for fast large-committee reads
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const [fast, normal] = await Promise.all([sdk.fastGetCommittee(committeeId), sdk.getCommittee(committeeId)])
      expect(fast).not.toBeNull()
      expect(fast!.totalMembers).toBe(normal!.totalMembers)
      expect(fast!.totalVotes).toBe(normal!.totalVotes)
      expect(fast!.govs).toEqual(normal!.govs)
    })

    test('fastGetCommittee throws for non-existent committee', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet)
      await expect(sdk.fastGetCommittee(new Uint8Array(32))).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('getCommitteeGovs returns all govs with correct votes', async () => {
      const { sdk, committeeId, committeeFile } = await deployRegistryWithCommittee(localnet)
      const govs = await sdk.getCommitteeGovs(committeeId)
      expect(govs).toHaveLength(committeeFile.totalMembers)
      expect(govs.reduce((acc, { votes }) => acc + votes, 0)).toBe(committeeFile.totalVotes)
    })

    test('getGovVotingPowers returns votes for member and 0 for non-member', async () => {
      // tryGetGovVotingPower wrapper: batches power lookups via simulate group
      const { sdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const memberPowers = await sdk.getGovVotingPowers([committeeId], govAccounts[0].toString())
      expect(memberPowers[0]).toBeGreaterThan(0)
      const unknownPowers = await sdk.getGovVotingPowers([committeeId], unknown.toString())
      expect(unknownPowers[0]).toBe(0)
    })

    test('getCommitteeIds returns all registered committee IDs', async () => {
      const { sdk, committeeId1, committeeId2 } = await deployRegistryWithTwoCommittees(localnet)
      const ids = await sdk.getCommitteeIds()
      expect(ids).toHaveLength(2)
      expect(ids.map((id) => Buffer.from(id).toString('base64'))).toEqual(
        expect.arrayContaining([
          Buffer.from(committeeId1).toString('base64'),
          Buffer.from(committeeId2).toString('base64'),
        ]),
      )
    })

    test('getAllDelegations returns map of all active delegations', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator1, delegator2] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, delegator1).setVotingAccount({ votingAddress: votingAddress.toString() })
      await createSDK(localnet, sdk.appId, delegator2).setVotingAccount({ votingAddress: votingAddress.toString() })
      const delegations = await sdk.getAllDelegations()
      expect(delegations.size).toBe(2)
      expect(delegations.get(delegator1.toString())).toBe(votingAddress.toString())
      expect(delegations.get(delegator2.toString())).toBe(votingAddress.toString())
    })

    test('getAllPeriodSummaries returns all active periods', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      const summaries = await sdk.getAllPeriodSummaries()
      expect(summaries).toHaveLength(1)
      expect(summaries[0].summary.appId).toBeGreaterThan(0n)
    })

    test('getGlobalState returns current registry state including admin and round', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const state = await sdk.getGlobalState()
      expect(state.admin).toBe(testAccount.toString())
      expect(state.currentRound).toBeGreaterThan(0n)
    })
  })

  describe('batch reader stress', () => {
    test('getGovVotingPowers: 17 committeeIds with distinct votes verify index alignment across @chunked(16)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const gov = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeIds: Uint8Array[] = []
      const expectedPowers: number[] = []
      for (let i = 0; i < 17; i++) {
        const id = new Uint8Array(32)
        id[0] = i
        const votes = 10 + i * 5 // distinct votes per committee: 10, 15, 20 … 90
        await sdk.registerCommittee({
          committeeId: id,
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: votes,
          xGovRegistryId: 0n,
        })
        await sdk.ingestGovs({ committeeId: id, govs: [{ account: gov.toString(), votes }] })
        committeeIds.push(id)
        expectedPowers.push(votes)
      }
      const powers = await sdk.getGovVotingPowers(committeeIds, gov.toString())
      expect(powers).toEqual(expectedPowers)
    })

    test('getGGovAccountsMap: 129 addresses (100 known + 29 unknown) verify @chunked(128) with mixed entries', async () => {
      const { generateAccount } = await import('algosdk')
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 100)
      const unknownAddresses = Array.from({ length: 29 }, () => generateAccount().addr.toString())
      const allAddresses = [...govAccounts.map((a) => a.toString()), ...unknownAddresses]
      const accountsMap = await sdk.getGGovAccountsMap(allAddresses)
      expect(accountsMap.size).toBe(129)
      for (const address of govAccounts.map((a) => a.toString())) {
        const entry = accountsMap.get(address)!
        expect(entry.accountId).toBeGreaterThan(0)
        expect(entry.committeeOffsets).toHaveLength(1)
      }
      for (const address of unknownAddresses) {
        expect(accountsMap.get(address)!.accountId).toBe(0)
        expect(accountsMap.get(address)!.committeeOffsets).toHaveLength(0)
      }
    }, 120_000)

    test('getDelegations: 129 addresses (2 distinct delegatees at boundary positions) verify index alignment across @chunked(128)', async () => {
      const { ALGORAND_ZERO_ADDRESS_STRING, generateAccount } = await import('algosdk')
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [accountA, accountB] = govAccounts
      const delegateeA = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const delegateeB = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, accountA).setVotingAccount({ votingAddress: delegateeA.toString() })
      await createSDK(localnet, sdk.appId, accountB).setVotingAccount({ votingAddress: delegateeB.toString() })
      // accountA at index 0, 127 unregistered addresses, accountB at index 128
      const freshAddresses = Array.from({ length: 127 }, () => generateAccount().addr.toString())
      const addresses = [accountA.toString(), ...freshAddresses, accountB.toString()]
      const results = await sdk.getDelegations(addresses)
      expect(results).toHaveLength(129)
      expect(results[0]).toBe(delegateeA.toString())
      expect(results[128]).toBe(delegateeB.toString())
      expect(results.slice(1, 128).every((r) => r === ALGORAND_ZERO_ADDRESS_STRING)).toBe(true)
    })

    test('getPeriodSummaries: 129 IDs (3 known at positions 0/64/128) verify index alignment across @chunked(128)', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const knownIds = [
        await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
        await sdk.addPeriod({ committeeId, votingStart: now + 3800n, votingEnd: now + 7400n }),
        await sdk.addPeriod({ committeeId, votingStart: now + 7500n, votingEnd: now + 11100n }),
      ]
      // known periods at positions 0, 64, 128; unknown IDs everywhere else
      const ids = Array.from({ length: 129 }, (_, i) => {
        if (i === 0) return knownIds[0]
        if (i === 64) return knownIds[1]
        if (i === 128) return knownIds[2]
        return BigInt(9000 + i)
      })
      const summaries = await sdk.getPeriodSummaries(ids)
      expect(summaries).toHaveLength(129)
      expect(summaries[0].appId).toBeGreaterThan(0n)
      expect(summaries[64].appId).toBeGreaterThan(0n)
      expect(summaries[128].appId).toBeGreaterThan(0n)
      for (let i = 0; i < 129; i++) {
        if (i !== 0 && i !== 64 && i !== 128) expect(summaries[i].appId).toBe(0n)
      }
    })

    test('257 govs: fastGetCommittee and getCommitteeGovs independently match fixture across superbox page boundary', async () => {
      // 257 × 8 bytes = 2056 bytes, crossing the 2048-byte superbox page boundary.
      // fastGetCommittee (simulate+log) and getCommitteeGovs (direct box read) use different paths —
      // comparing both against committeeFile.govs catches page-read corruption in either.
      const { generateAccount } = await import('algosdk')
      const { testAccount } = localnet.context
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 257,
        totalVotes: 2570,
        registryId: 0,
        govs: Array.from({ length: 257 }, () => ({
          address: generateAccount().addr.toString(),
          votes: 10,
        })),
      }
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)
      const sortedFixture = [...committeeFile.govs].sort((a, b) => (a.address < b.address ? -1 : 1))
      const [fast, govs] = await Promise.all([sdk.fastGetCommittee(committeeId), sdk.getCommitteeGovs(committeeId)])
      expect(fast!.govs).toEqual(sortedFixture)
      expect(govs.map(({ account, votes }) => ({ address: account.toString(), votes }))).toEqual(sortedFixture)
    }, 120_000)

    test('getCommitteesMetadata: 129 committeeIds with distinct periodStart verify index alignment across @chunked(128)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const ids: Uint8Array[] = []
      for (let i = 0; i < 129; i++) {
        const id = new Uint8Array(32)
        id[0] = i % 256
        id[1] = Math.floor(i / 256)
        await sdk.registerCommittee({
          committeeId: id,
          periodStart: 50_000_000 + i,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        })
        ids.push(id)
      }
      const results = await sdk.getCommitteesMetadata(ids)
      expect(results).toHaveLength(129)
      for (let i = 0; i < 129; i++) {
        expect(results[i]).not.toBeNull()
        expect(results[i]!.periodStart).toBe(50_000_000 + i)
      }
    }, 180_000)

    test('uningestCommitteeGovs: 9 accounts span two 8-account write chunks, committee ends empty', async () => {
      const { sdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet, 9)
      await sdk.uningestCommitteeGovs({ committeeId, accounts: govAccounts.map((a) => a.toString()) })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata!.ingestedVotes).toBe(0)
      const accountsMap = await sdk.getGGovAccountsMap(govAccounts.map((a) => a.toString()))
      for (const [, account] of accountsMap) {
        expect(account.committeeOffsets).toHaveLength(0)
      }
    })
  })
})
