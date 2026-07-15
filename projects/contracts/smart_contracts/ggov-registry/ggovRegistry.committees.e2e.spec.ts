import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { calculateCommitteeId, GGovRegistrySDK, GGovCommitteeFile } from 'ggov-sdk'
import {
  errAccountNotExists,
  errAccountOffsetNotExists,
  errCommitteeExists,
  errCommitteeNotExists,
  errIngestedVotesNotZero,
  errNumGovsExceeded,
  errOutOfOrder,
  errPeriodEndLessThanStart,
  errTotalMembersZero,
  errTotalVotesExceeded,
  errTotalVotesMismatch,
  errTotalVotesZero,
  errTotalGovsExceeded,
  errZeroVotes,
} from '../base/errors.algo'
import {
  deployRegistry,
  deployRegistryWithCommittee,
  deployRegistryWithTwoCommittees,
  transformedError,
} from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'
import { committeesForTests } from './fixtures'
import { configureTestLogging } from '../test-utils'

describe('GGovRegistry committees', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('registerCommittee', () => {
    test('registers a committee and metadata is retrievable', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = new Uint8Array(32).fill(1)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 3,
        totalVotes: 30,
        xGovRegistryId: 0n,
      })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata).toBeDefined()
      expect(metadata!.periodStart).toBe(50_000_000)
      expect(metadata!.periodEnd).toBe(53_000_000)
      expect(metadata!.totalMembers).toBe(3)
      expect(metadata!.totalVotes).toBe(30)
      expect(metadata!.ingestedVotes).toBe(0)
    })

    test('rejects totalMembers=0', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(
        sdk.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 0,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errTotalMembersZero))
    })

    test('rejects totalVotes=0', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(
        sdk.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 0,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errTotalVotesZero))
    })

    test('rejects duplicate committeeId', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      await expect(
        sdk.registerCommittee({
          committeeId,
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errCommitteeExists))
    })

    test('rejects periodEnd <= periodStart', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(
        sdk.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 53_000_000,
          periodEnd: 50_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errPeriodEndLessThanStart))
    })
  })

  describe('unregisterCommittee', () => {
    test('succeeds on empty committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      await sdk.unregisterCommittee({ committeeId })

      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata).toBeNull()
    })

    test('fails on committee with ingested votes', async () => {
      const { testAccount } = localnet.context
      const govAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        govs: [{ address: govAccount.toString(), votes: 10 }],
      }
      const { sdk } = await deployRegistry(localnet, testAccount)
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      await expect(sdk.unregisterCommittee({ committeeId })).rejects.toThrow(transformedError(errIngestedVotesNotZero))
    })

    test('fails on nonexistent committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.unregisterCommittee({ committeeId: new Uint8Array(32) })).rejects.toThrow(
        transformedError(errCommitteeNotExists),
      )
    })

    test('succeeds after full uningest', async () => {
      const { sdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
      await sdk.uningestCommitteeGovs({ committeeId, accounts: govAccounts.map((a) => a.toString()) })
      await sdk.unregisterCommittee({ committeeId })
      expect(await sdk.getCommitteeMetadata(committeeId)).toBeNull()
    })
  })

  describe('ingestGovs', () => {
    test('rejects exceeding totalMembers', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const govAccounts = await Promise.all(
        Array.from({ length: 3 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 20,
        registryId: 0,
        govs: govAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalGovsExceeded))
    })

    test('rejects exceeding totalVotes', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const govAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // totalVotes=10 but 2 members with 10 votes each = 20
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 10,
        registryId: 0,
        govs: govAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalVotesExceeded))
    })

    test('enforces totalVotes match at completion', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const govAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // totalVotes=30 but 2 members with 10 votes each = 20
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 30,
        registryId: 0,
        govs: govAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalVotesMismatch))
    })

    test('rejects zero-vote gov', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const govAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // one member carries 0 votes; totals still add up but the zero-vote entry must be rejected
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 10,
        registryId: 0,
        govs: [
          { address: govAccounts[0].toString(), votes: 10 },
          { address: govAccounts[1].toString(), votes: 0 },
        ],
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errZeroVotes))
    })

    test('enforces govs in ascending account ID order', async () => {
      const { sdk, sorted, committeeFile } = await deployRegistryWithCommittee(localnet, 5)
      const votesPerMember = 5
      const newCommitteeFile: GGovCommitteeFile = {
        ...committeeFile,
        totalMembers: committeeFile.totalMembers + 1,
        totalVotes: committeeFile.totalVotes + votesPerMember,
        periodStart: committeeFile.periodStart + 3_000_000,
        periodEnd: committeeFile.periodEnd + 3_000_000,
      }
      const newCommitteeId = calculateCommitteeId(JSON.stringify(newCommitteeFile))
      await sdk.registerCommittee({
        committeeId: newCommitteeId,
        periodStart: newCommitteeFile.periodStart,
        periodEnd: newCommitteeFile.periodEnd,
        totalMembers: newCommitteeFile.totalMembers,
        totalVotes: newCommitteeFile.totalVotes,
        xGovRegistryId: 0n,
      })
      const govsToIngestSorted = sorted.map((x) => ({ account: x.address, votes: votesPerMember }))
      govsToIngestSorted.push({
        account: (await localnet.context.generateAccount({ initialFunds: (1).algos() })).toString(),
        votes: votesPerMember,
      })

      await expect(
        sdk.ingestGovs({
          committeeId: newCommitteeId,
          govs: [govsToIngestSorted.at(-1)!, ...govsToIngestSorted.slice(0, -1)],
        }),
      ).rejects.toThrow(transformedError(errOutOfOrder))
      await expect(
        sdk.ingestGovs({
          committeeId: newCommitteeId,
          govs: [govsToIngestSorted[1], govsToIngestSorted[0], ...govsToIngestSorted.slice(2)],
        }),
      ).rejects.toThrow(transformedError(errOutOfOrder))
    })

    test('works in multiple batches', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      // 10 govs will be split into multiple ingest chunks (8 per chunk)
      const govAccounts = await Promise.all(
        Array.from({ length: 10 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const votesPerMember = 5
      const committeeFile: GGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 10,
        totalVotes: 10 * votesPerMember,
        registryId: 0,
        govs: govAccounts.map((a) => ({ address: a.toString(), votes: votesPerMember })),
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata).toBeDefined()
      expect(metadata!.ingestedVotes).toBe(committeeFile.totalVotes)
      expect(metadata!.totalMembers).toBe(10)

      // verify all 10 accounts have voting power
      for (const gov of govAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getGovVotingPower({
          args: { committeeId, account: gov.toString() },
        })
        expect(votingPower).toBe(votesPerMember)
      }
    })
  })

  describe('uningestGovs', () => {
    test('removes specific accounts', async () => {
      const { sdk, committeeId, committeeFile, sorted } = await deployRegistryWithCommittee(localnet)
      const lastAccount = sorted[sorted.length - 1]
      await sdk.uningestGovs({ committeeId, govs: [lastAccount.address] })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata!.ingestedVotes).toBe(
        committeeFile.totalVotes - committeeFile.govs.find((x) => x.address === lastAccount.address)!.votes,
      )
      await expect(
        sdk.readClient.send.getGovVotingPower({ args: { committeeId, account: lastAccount.address } }),
      ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
    })

    test('uningest from one committee preserves other committee offset', async () => {
      const { sdk, committeeId1, committeeId2, accountA, accountB } = await deployRegistryWithTwoCommittees(localnet)
      await sdk.uningestCommitteeGovs({
        committeeId: committeeId1,
        accounts: [accountA.toString(), accountB.toString()],
      })
      const { return: votingPower } = await sdk.readClient.send.getGovVotingPower({
        args: { committeeId: committeeId2, account: accountB.toString() },
      })
      expect(votingPower).toBe(10)
      const { return: registryAccount } = await sdk.readClient.send.getAccount({
        args: { account: accountB.toString() },
      })
      expect(registryAccount!.committeeOffsets).toHaveLength(1)
      // The surviving offset is the second committee's; numeric IDs start at 1, so it is 2.
      expect(registryAccount!.committeeOffsets[0][0]).toBe(2)
      const { return: registryAccountA } = await sdk.readClient.send.getAccount({
        args: { account: accountA.toString() },
      })
      expect(registryAccountA!.committeeOffsets).toHaveLength(0)
    })

    test('rejects account not ingested in this committee', async () => {
      const { sdk, committeeId2, accountA } = await deployRegistryWithTwoCommittees(localnet)
      await expect(sdk.uningestGovs({ committeeId: committeeId2, govs: [accountA.toString()] })).rejects.toThrow(
        transformedError(errAccountOffsetNotExists),
      )
    })

    test('rejects wrong order (not reverse ingestion order)', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // try to uningest the first account (should be last since it has lowest offset)
      await expect(sdk.uningestGovs({ committeeId, govs: [sorted[0].address] })).rejects.toThrow(
        transformedError(errOutOfOrder),
      )
    })

    test('rejects unknown account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(sdk.uningestGovs({ committeeId, govs: [randomAccount.toString()] })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
    })

    test('rejects more govs than exist', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // uningest all 3 first
      for (let i = sorted.length - 1; i >= 0; i--) {
        await sdk.uningestGovs({ committeeId, govs: [sorted[i].address] })
      }
      // now try to uningest one more
      await expect(sdk.uningestGovs({ committeeId, govs: [sorted[0].address] })).rejects.toThrow(
        transformedError(errNumGovsExceeded),
      )
    })

    test('allows re-ingestion after full uningest', async () => {
      const { sdk, committeeId, committeeFile, govAccounts } = await deployRegistryWithCommittee(localnet)
      const allAddresses = govAccounts.map((a) => a.toString())

      // uningest all
      await sdk.uningestCommitteeGovs({ committeeId, accounts: allAddresses })
      const metadataAfterUningest = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataAfterUningest!.ingestedVotes).toBe(0)

      // re-ingest by uploading the same committee file (skips register, resumes ingest)
      await sdk.uploadCommitteeFile(committeeFile)

      // verify fully ingested again
      const metadataAfterReingest = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataAfterReingest!.ingestedVotes).toBe(committeeFile.totalVotes)

      // verify all accounts have voting power
      for (const gov of govAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getGovVotingPower({
          args: { committeeId, account: gov.toString() },
        })
        expect(votingPower).toBe(10)
      }
    })
  })

  describe('uploadCommitteeFile (SDK wrapper)', () => {
    let sdk: GGovRegistrySDK
    const uploadedIds: Uint8Array[] = []

    beforeAll(async () => {
      await localnet.newScope()
      ;({ sdk } = await deployRegistry(localnet, localnet.context.testAccount))
      await localnet.algorand.account.ensureFundedFromEnvironment(sdk.readClient.appAddress, (30).algos())
      for (const [, , committeeFile] of committeesForTests) {
        uploadedIds.push(await sdk.uploadCommitteeFile(committeeFile))
      }
    })

    // registerCommittee + ingestGovs
    for (const [i, [name, id, committeeFile]] of committeesForTests.entries()) {
      test(`uploads committee ${name}`, async () => {
        const committeeId = calculateCommitteeId(JSON.stringify(committeeFile))
        expect(committeeId).toEqual(new Uint8Array(Buffer.from(id, 'base64')))
        expect(uploadedIds[i]).toEqual(committeeId)

        const storedCommittee = await sdk.getCommittee(committeeId)
        expect(storedCommittee).toBeDefined()
        expect(storedCommittee!.periodStart).toEqual(committeeFile.periodStart)
        expect(storedCommittee!.periodEnd).toEqual(committeeFile.periodEnd)
        expect(storedCommittee!.totalMembers).toEqual(committeeFile.totalMembers)
        expect(storedCommittee!.totalVotes).toEqual(committeeFile.totalVotes)
        expect(storedCommittee!.govs).toEqual(committeeFile.govs)
        expect(storedCommittee!.govs.length).toEqual(storedCommittee!.totalMembers)
        expect(storedCommittee!.govs.reduce((acc, g) => acc + g.votes, 0)).toEqual(storedCommittee!.totalVotes)
      })
    }

    test('getCommitteeIds returns all uploaded committees', async () => {
      const ids = await sdk.getCommitteeIds()
      expect(ids).toHaveLength(committeesForTests.length)
      for (const id of uploadedIds) {
        expect(ids).toContainEqual(id)
      }
    })

    test('getCommitteesMetadata returns correct metadata for all known and null for unknown', async () => {
      const unknown = new Uint8Array(32)
      const results = await sdk.getCommitteesMetadata([...uploadedIds, unknown])
      expect(results).toHaveLength(uploadedIds.length + 1)
      for (const [i, [, , committeeFile]] of committeesForTests.entries()) {
        expect(results[i]).not.toBeNull()
        expect(results[i]!.periodStart).toEqual(committeeFile.periodStart)
        expect(results[i]!.periodEnd).toEqual(committeeFile.periodEnd)
      }
      expect(results[uploadedIds.length]).toBeNull()
    })
  })

  describe('uningestCommitteeGovs (SDK wrapper)', () => {
    // uningest all govs from committee (uningestGovs wrapper)
    test('removes all members from a fully ingested committee', async () => {
      const { sdk, committeeId, govAccounts } = await deployRegistryWithCommittee(localnet)
      const allAddresses = govAccounts.map((a) => a.toString())
      await sdk.uningestCommitteeGovs({ committeeId, accounts: allAddresses })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata!.ingestedVotes).toBe(0)
      for (const gov of govAccounts) {
        await expect(
          sdk.readClient.send.getGovVotingPower({ args: { committeeId, account: gov.toString() } }),
        ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
      }
      const gGovAccountsMap = await sdk.getGGovAccountsMap(allAddresses)
      for (const [, gGovAccount] of Array.from(gGovAccountsMap.entries())) {
        expect(gGovAccount.committeeOffsets).toHaveLength(0)
      }
    })
  })
})
