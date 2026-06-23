import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { calculateCommitteeId, GGovRegistrySDK, XGovCommitteeFile } from 'ggov-sdk'
import {
  errAccountNotExists,
  errAccountOffsetNotExists,
  errCommitteeExists,
  errCommitteeNotExists,
  errIngestedVotesNotZero,
  errNumXGovsExceeded,
  errOutOfOrder,
  errPeriodEndLessThanStart,
  errTotalMembersZero,
  errTotalVotesExceeded,
  errTotalVotesMismatch,
  errTotalVotesZero,
  errTotalXGovsExceeded,
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
      const xGovAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        xGovs: [{ address: xGovAccount.toString(), votes: 10 }],
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
      const { sdk, committeeId, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      await sdk.uningestCommitteeXGovs({ committeeId, accounts: xGovAccounts.map((a) => a.toString()) })
      await sdk.unregisterCommittee({ committeeId })
      expect(await sdk.getCommitteeMetadata(committeeId)).toBeNull()
    })
  })

  describe('ingestXGovs', () => {
    test('rejects exceeding totalMembers', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const xGovAccounts = await Promise.all(
        Array.from({ length: 3 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 20,
        registryId: 0,
        xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalXGovsExceeded))
    })

    test('rejects exceeding totalVotes', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const xGovAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // totalVotes=10 but 2 members with 10 votes each = 20
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 10,
        registryId: 0,
        xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalVotesExceeded))
    })

    test('enforces totalVotes match at completion', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const xGovAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // totalVotes=30 but 2 members with 10 votes each = 20
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 30,
        registryId: 0,
        xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errTotalVotesMismatch))
    })

    test('rejects zero-vote xGov', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const xGovAccounts = await Promise.all(
        Array.from({ length: 2 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      // one member carries 0 votes; totals still add up but the zero-vote entry must be rejected
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 2,
        totalVotes: 10,
        registryId: 0,
        xGovs: [
          { address: xGovAccounts[0].toString(), votes: 10 },
          { address: xGovAccounts[1].toString(), votes: 0 },
        ],
      }
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(transformedError(errZeroVotes))
    })

    test('enforces xGovs in ascending account ID order', async () => {
      const { sdk, sorted, committeeFile } = await deployRegistryWithCommittee(localnet, 5)
      const votesPerMember = 5
      const newCommitteeFile: XGovCommitteeFile = {
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
      const xGovsToIngestSorted = sorted.map((x) => ({ account: x.address, votes: votesPerMember }))
      xGovsToIngestSorted.push({
        account: (await localnet.context.generateAccount({ initialFunds: (1).algos() })).toString(),
        votes: votesPerMember,
      })

      await expect(
        sdk.ingestXGovs({
          committeeId: newCommitteeId,
          xGovs: [xGovsToIngestSorted.at(-1)!, ...xGovsToIngestSorted.slice(0, -1)],
        }),
      ).rejects.toThrow(transformedError(errOutOfOrder))
      await expect(
        sdk.ingestXGovs({
          committeeId: newCommitteeId,
          xGovs: [xGovsToIngestSorted[1], xGovsToIngestSorted[0], ...xGovsToIngestSorted.slice(2)],
        }),
      ).rejects.toThrow(transformedError(errOutOfOrder))
    })

    test('works in multiple batches', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      // 10 xGovs will be split into multiple ingest chunks (8 per chunk)
      const xGovAccounts = await Promise.all(
        Array.from({ length: 10 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const votesPerMember = 5
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 10,
        totalVotes: 10 * votesPerMember,
        registryId: 0,
        xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: votesPerMember })),
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata).toBeDefined()
      expect(metadata!.ingestedVotes).toBe(committeeFile.totalVotes)
      expect(metadata!.totalMembers).toBe(10)

      // verify all 10 accounts have voting power
      for (const xGov of xGovAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
          args: { committeeId, account: xGov.toString() },
        })
        expect(votingPower).toBe(votesPerMember)
      }
    })
  })

  describe('uningestXGovs', () => {
    test('removes specific accounts', async () => {
      const { sdk, committeeId, committeeFile, sorted } = await deployRegistryWithCommittee(localnet)
      const lastAccount = sorted[sorted.length - 1]
      await sdk.uningestXGovs({ committeeId, xGovs: [lastAccount.address] })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata!.ingestedVotes).toBe(
        committeeFile.totalVotes - committeeFile.xGovs.find((x) => x.address === lastAccount.address)!.votes,
      )
      await expect(
        sdk.readClient.send.getXGovVotingPower({ args: { committeeId, account: lastAccount.address } }),
      ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
    })

    test('uningest from one committee preserves other committee offset', async () => {
      const { sdk, committeeId1, committeeId2, accountA, accountB } = await deployRegistryWithTwoCommittees(localnet)
      await sdk.uningestCommitteeXGovs({
        committeeId: committeeId1,
        accounts: [accountA.toString(), accountB.toString()],
      })
      const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
        args: { committeeId: committeeId2, account: accountB.toString() },
      })
      expect(votingPower).toBe(10)
      const { return: registryAccount } = await sdk.readClient.send.getAccount({
        args: { account: accountB.toString() },
      })
      expect(registryAccount!.committeeOffsets).toHaveLength(1)
      expect(registryAccount!.committeeOffsets[0][0]).toBe(1)
      const { return: registryAccountA } = await sdk.readClient.send.getAccount({
        args: { account: accountA.toString() },
      })
      expect(registryAccountA!.committeeOffsets).toHaveLength(0)
    })

    test('rejects account not ingested in this committee', async () => {
      const { sdk, committeeId2, accountA } = await deployRegistryWithTwoCommittees(localnet)
      await expect(sdk.uningestXGovs({ committeeId: committeeId2, xGovs: [accountA.toString()] })).rejects.toThrow(
        transformedError(errAccountOffsetNotExists),
      )
    })

    test('rejects wrong order (not reverse ingestion order)', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // try to uningest the first account (should be last since it has lowest offset)
      await expect(sdk.uningestXGovs({ committeeId, xGovs: [sorted[0].address] })).rejects.toThrow(
        transformedError(errOutOfOrder),
      )
    })

    test('rejects unknown account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(sdk.uningestXGovs({ committeeId, xGovs: [randomAccount.toString()] })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
    })

    test('rejects more xGovs than exist', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // uningest all 3 first
      for (let i = sorted.length - 1; i >= 0; i--) {
        await sdk.uningestXGovs({ committeeId, xGovs: [sorted[i].address] })
      }
      // now try to uningest one more
      await expect(sdk.uningestXGovs({ committeeId, xGovs: [sorted[0].address] })).rejects.toThrow(
        transformedError(errNumXGovsExceeded),
      )
    })

    test('allows re-ingestion after full uningest', async () => {
      const { sdk, committeeId, committeeFile, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const allAddresses = xGovAccounts.map((a) => a.toString())

      // uningest all
      await sdk.uningestCommitteeXGovs({ committeeId, accounts: allAddresses })
      const metadataAfterUningest = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataAfterUningest!.ingestedVotes).toBe(0)

      // re-ingest by uploading the same committee file (skips register, resumes ingest)
      await sdk.uploadCommitteeFile(committeeFile)

      // verify fully ingested again
      const metadataAfterReingest = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataAfterReingest!.ingestedVotes).toBe(committeeFile.totalVotes)

      // verify all accounts have voting power
      for (const xGov of xGovAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
          args: { committeeId, account: xGov.toString() },
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

    // registerCommittee + ingestXGovs
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
        expect(storedCommittee!.xGovs).toEqual(committeeFile.xGovs)
        expect(storedCommittee!.xGovs.length).toEqual(storedCommittee!.totalMembers)
        expect(storedCommittee!.xGovs.reduce((acc, g) => acc + g.votes, 0)).toEqual(storedCommittee!.totalVotes)
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

  describe('uningestCommitteeXGovs (SDK wrapper)', () => {
    // uningest all xGovs from committee (uningestXGovs wrapper)
    test('removes all members from a fully ingested committee', async () => {
      const { sdk, committeeId, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const allAddresses = xGovAccounts.map((a) => a.toString())
      await sdk.uningestCommitteeXGovs({ committeeId, accounts: allAddresses })
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata!.ingestedVotes).toBe(0)
      for (const xGov of xGovAccounts) {
        await expect(
          sdk.readClient.send.getXGovVotingPower({ args: { committeeId, account: xGov.toString() } }),
        ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
      }
      const gGovAccountsMap = await sdk.getGGovAccountsMap(allAddresses)
      for (const [, gGovAccount] of Array.from(gGovAccountsMap.entries())) {
        expect(gGovAccount.committeeOffsets).toHaveLength(0)
      }
    })
  })
})
