import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  calculateCommitteeId,
  increaseBudgetBaseCost,
  increaseBudgetIncrementCost,
  XGovCommitteeFile,
  GGovRegistrySDK,
} from 'ggov-registry-sdk'
import {
  errCommitteeExists,
  errCommitteeIncomplete,
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
  errUnauthorized,
} from '../base/errors.algo'
import { committeesForTests } from './fixtures'
import { deployRegistry, deployRegistryWithCommittee, deployRegistryWithTwoCommittees, transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'

describe('GGovRegistry contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  describe('increaseBudget opcode cost', () => {
    for (let i = 0; i < 3; i++) {
      test(`It should cost ${increaseBudgetBaseCost + i * increaseBudgetIncrementCost} with itxns=${i}`, async () => {
        const { testAccount } = localnet.context
        const sender = testAccount.toString()
        const signer = testAccount.signer

        const { sdk } = await deployRegistry(localnet, testAccount)

        const {
          simulateResponse: {
            txnGroups: [{ appBudgetConsumed }],
          },
        } = await sdk
          .writeClient!.newGroup()
          .increaseBudget({ sender, signer, args: { itxns: BigInt(i) }, extraFee: (i * 1000).microAlgo() })
          .simulate()

        expect(appBudgetConsumed).toBe(increaseBudgetBaseCost + i * increaseBudgetIncrementCost) // if this fails then update the new value in SDK/constants
      })
    }
  })

  for (const [name, id, committeeFile] of committeesForTests) {
    test(`Uploads committee ${name}`, async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)

      const committeeId = calculateCommitteeId(JSON.stringify(committeeFile))
      expect(committeeId).toEqual(new Uint8Array(Buffer.from(id, 'base64')))

      const result = await sdk.uploadCommitteeFile(committeeFile)
      expect(result).toEqual(committeeId)

      const storedCommittee = await sdk.getCommittee(committeeId)
      expect(storedCommittee).toBeDefined()
      expect(storedCommittee!.periodStart).toEqual(committeeFile.periodStart)
      expect(storedCommittee!.periodEnd).toEqual(committeeFile.periodEnd)
      expect(storedCommittee!.totalMembers).toEqual(committeeFile.totalMembers)
      expect(storedCommittee!.totalVotes).toEqual(committeeFile.totalVotes)
      expect(storedCommittee!.xGovs).toEqual(committeeFile.xGovs)
    })
  }

  describe('oracle accounts', () => {
    test('getAccount returns GGovAccount with committeeOffsets after ingestion', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet)

      for (const xGov of xGovAccounts) {
        const { return: oracleAccount } = await sdk.readClient.send.getAccount({
          args: { account: xGov.toString() },
        })
        expect(oracleAccount).toBeDefined()
        expect(oracleAccount!.accountId).toBeGreaterThan(0)
        // should have exactly one committee offset entry
        expect(oracleAccount!.committeeOffsets).toHaveLength(1)
        // committee numericId should be 0 (first committee)
        expect(oracleAccount!.committeeOffsets[0][0]).toBe(0)
      }
    })

    test('getAccount returns zero accountId for unknown account', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { return: oracleAccount } = await sdk.readClient.send.getAccount({
        args: { account: randomAccount.toString() },
      })
      expect(oracleAccount).toBeDefined()
      expect(oracleAccount!.accountId).toBe(0)
      expect(oracleAccount!.committeeOffsets).toHaveLength(0)
    })

    test('getXGovVotingPower returns correct votes without offset hint', async () => {
      const { sdk, committeeId, committeeFile, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const committeeIdRaw = committeeId

      for (const xGov of xGovAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
          args: { committeeId: committeeIdRaw, account: xGov.toString() },
        })
        const expectedVotes = committeeFile.xGovs.find((x) => x.address === xGov.toString())!.votes
        expect(votingPower).toBe(expectedVotes)
      }
    })

    test('getXGovVotingPower fails for non-member account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        sdk.readClient.send.getXGovVotingPower({
          args: { committeeId, account: randomAccount.toString() },
        }),
      ).rejects.toThrow(transformedError('ERR:A_NX'))
    })

    test('uningestXGovs removes specific accounts', async () => {
      const { sdk, committeeId, committeeFile, sorted } = await deployRegistryWithCommittee(localnet)

      // uningest the last account (must provide in reverse ingestion order)
      const lastAccount = sorted[sorted.length - 1]
      await sdk.uningestXGovs({ committeeId, xGovs: [lastAccount.address] })

      // verify committee metadata updated
      const metadata = await sdk.getCommitteeMetadata(committeeId)
      expect(metadata).toBeDefined()
      expect(metadata!.ingestedVotes).toBe(committeeFile.totalVotes - committeeFile.xGovs.find((x) => x.address === lastAccount.address)!.votes)

      // verify the uningest account no longer has voting power
      await expect(
        sdk.readClient.send.getXGovVotingPower({
          args: { committeeId, account: lastAccount.address },
        }),
      ).rejects.toThrow(transformedError('ERR:AO_NX'))
    })

    test('account in two committees has two committeeOffsets', async () => {
      const { sdk, accountB } = await deployRegistryWithTwoCommittees(localnet)

      const { return: oracleAccount } = await sdk.readClient.send.getAccount({
        args: { account: accountB.toString() },
      })
      expect(oracleAccount).toBeDefined()
      expect(oracleAccount!.accountId).toBeGreaterThan(0)
      expect(oracleAccount!.committeeOffsets).toHaveLength(2)

      // numericId 0 = first committee, numericId 1 = second committee
      const numericIds = oracleAccount!.committeeOffsets.map(([cId]) => cId).sort()
      expect(numericIds).toEqual([0, 1])
    })

    test('uningest from one committee preserves other committee offset', async () => {
      const { sdk, committeeId1, committeeId2, accountA, accountB } = await deployRegistryWithTwoCommittees(localnet)

      // uningest committee 1 fully (B then A — reverse ingestion order)
      await sdk.uningestCommitteeXGovs({ committeeId: committeeId1, accounts: [accountA.toString(), accountB.toString()] })

      // accountB should still have voting power in committee 2
      const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
        args: { committeeId: committeeId2, account: accountB.toString() },
      })
      expect(votingPower).toBe(10)

      // accountB should have exactly 1 committee offset remaining (committee 2)
      const { return: oracleAccount } = await sdk.readClient.send.getAccount({
        args: { account: accountB.toString() },
      })
      expect(oracleAccount!.committeeOffsets).toHaveLength(1)
      expect(oracleAccount!.committeeOffsets[0][0]).toBe(1) // numericId 1

      // accountA should have zero committee offsets
      const { return: oracleAccountA } = await sdk.readClient.send.getAccount({
        args: { account: accountA.toString() },
      })
      expect(oracleAccountA!.committeeOffsets).toHaveLength(0)
    })

    test('uningestCommitteeXGovs removes all members from a fully ingested committee', async () => {
      const { sdk, committeeId, committeeFile, xGovAccounts } = await deployRegistryWithCommittee(localnet)

      // verify committee is fully ingested
      const metadataBefore = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataBefore).toBeDefined()
      expect(metadataBefore!.ingestedVotes).toBe(committeeFile.totalVotes)

      // uningest all members via wrapper (handles reverse order internally)
      const allAddresses = xGovAccounts.map((a) => a.toString())
      await sdk.uningestCommitteeXGovs({ committeeId, accounts: allAddresses })

      // verify committee metadata shows zero ingested votes
      const metadataAfter = await sdk.getCommitteeMetadata(committeeId)
      expect(metadataAfter).toBeDefined()
      expect(metadataAfter!.ingestedVotes).toBe(0)

      // verify no account has voting power anymore
      for (const xGov of xGovAccounts) {
        await expect(
          sdk.readClient.send.getXGovVotingPower({
            args: { committeeId, account: xGov.toString() },
          }),
        ).rejects.toThrow(transformedError('ERR:AO_NX'))
      }

      // verify account offset hints are cleaned up
      const gGovAccountsMap = await sdk.getGGovAccountsMap(allAddresses)
      for (const [, gGovAccount] of Array.from(gGovAccountsMap.entries())) {
        expect(gGovAccount.committeeOffsets).toHaveLength(0)
      }
    })
  })

  describe('registerCommittee', () => {
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

      await expect(sdk.unregisterCommittee({ committeeId })).rejects.toThrow(
        transformedError(errIngestedVotesNotZero),
      )
    })

    test('fails on nonexistent committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.unregisterCommittee({ committeeId: new Uint8Array(32) })).rejects.toThrow(
        transformedError(errCommitteeNotExists),
      )
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
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(
        transformedError(errTotalXGovsExceeded),
      )
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
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(
        transformedError(errTotalVotesExceeded),
      )
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
      await expect(sdk.uploadCommitteeFile(committeeFile)).rejects.toThrow(
        transformedError(errTotalVotesMismatch),
      )
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
    test('rejects wrong order (not reverse ingestion order)', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // try to uningest the first account (should be last since it has lowest offset)
      await expect(
        sdk.uningestXGovs({ committeeId, xGovs: [sorted[0].address] }),
      ).rejects.toThrow(transformedError(errOutOfOrder))
    })

    test('rejects unknown account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const randomAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        sdk.uningestXGovs({ committeeId, xGovs: [randomAccount.toString()] }),
      ).rejects.toThrow(transformedError('ERR:A_NX'))
    })

    test('rejects more xGovs than exist', async () => {
      const { sdk, committeeId, sorted } = await deployRegistryWithCommittee(localnet)
      // uningest all 3 first
      for (let i = sorted.length - 1; i >= 0; i--) {
        await sdk.uningestXGovs({ committeeId, xGovs: [sorted[i].address] })
      }
      // now try to uningest one more
      await expect(
        sdk.uningestXGovs({ committeeId, xGovs: [sorted[0].address] }),
      ).rejects.toThrow(transformedError(errNumXGovsExceeded))
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

  describe('read methods', () => {
    test('getCommitteeSuperboxMeta returns correct data after ingestion', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const numXGovs = 3
      const xGovAccounts = await Promise.all(
        Array.from({ length: numXGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
      )
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: numXGovs,
        totalVotes: numXGovs * 10,
        registryId: 0,
        xGovs: xGovAccounts.map((a) => ({ address: a.toString(), votes: 10 })),
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)

      const sbMeta = await sdk.getCommitteeSuperboxMeta(committeeId)
      expect(sbMeta).toBeDefined()
      // each xGov is stored as (uint32, uint32) = 8 bytes
      expect(Number(sbMeta.totalByteLength)).toBe(numXGovs * 8)
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
  })

  describe('auth', () => {
    test('non-admin cannot registerCommittee', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployRegistry(localnet, testAccount)
      // create a separate SDK with non-admin writer
      const nonAdminSDK = new GGovRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: sdk.appId,
        writerAccount: {
          sender: nonAdmin,
          signer: localnet.algorand.account.getSigner(nonAdmin),
        },
      })
      await expect(
        nonAdminSDK.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot ingestXGovs', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployRegistry(localnet, testAccount)
      // register committee as admin
      const committeeId = new Uint8Array(32)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      // try to ingest as non-admin
      const nonAdminSDK = new GGovRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: sdk.appId,
        writerAccount: {
          sender: nonAdmin,
          signer: localnet.algorand.account.getSigner(nonAdmin),
        },
      })
      await expect(
        nonAdminSDK.ingestXGovs({
          committeeId,
          xGovs: [{ account: nonAdmin.toString(), votes: 10 }],
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot uningestXGovs', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
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
      const nonAdminSDK = new GGovRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: sdk.appId,
        writerAccount: {
          sender: nonAdmin,
          signer: localnet.algorand.account.getSigner(nonAdmin),
        },
      })
      await expect(
        nonAdminSDK.uningestXGovs({ committeeId, xGovs: [xGovAccount.toString()] }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })

  describe('admin transfer and lifecycle', () => {
    test('admin defaults to creator on deploy', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const admin = await sdk.getAdmin()
      expect(admin).toBe(testAccount.toString())
    })

    test('admin can transfer to new admin and old admin loses access', async () => {
      const { testAccount } = localnet.context
      const newAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk, client } = await deployRegistry(localnet, testAccount)

      await sdk.setAdmin({ newAdmin: newAdmin.toString() })
      expect(await sdk.getAdmin()).toBe(newAdmin.toString())

      // old admin can no longer call admin-gated methods
      await expect(
        sdk.registerCommittee({
          committeeId: new Uint8Array(32),
          periodStart: 50_000_000,
          periodEnd: 53_000_000,
          totalMembers: 1,
          totalVotes: 10,
          xGovRegistryId: 0n,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))

      // new admin can call admin-gated methods (use setOperator as a simple no-side-effect example)
      const newAdminSDK = new GGovRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: client.appId,
        writerAccount: { sender: newAdmin, signer: localnet.algorand.account.getSigner(newAdmin) },
      })
      await expect(newAdminSDK.setOperator({ account: newAdmin.toString() })).resolves.toBeDefined()
    })

    test('non-admin cannot setAdmin', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { sdk } = await deployRegistry(localnet, testAccount)
      const nonAdminSDK = new GGovRegistrySDK({
        algorand: localnet.algorand,
        registryAppId: sdk.appId,
        writerAccount: { sender: nonAdmin, signer: localnet.algorand.account.getSigner(nonAdmin) },
      })
      await expect(nonAdminSDK.setAdmin({ newAdmin: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('admin cannot transfer to zero address', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      await expect(sdk.setAdmin({ newAdmin: ALGORAND_ZERO_ADDRESS_STRING })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('admin can update the registry app', async () => {
      const { testAccount } = localnet.context
      const { client } = await deployRegistry(localnet, testAccount)
      const sender = testAccount.toString()
      const signer = testAccount.signer
      await expect(client.send.update.bare({ sender, signer })).resolves.toBeDefined()
    })

    test('non-admin cannot update the registry app', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { client } = await deployRegistry(localnet, testAccount)
      await expect(
        client.send.update.bare({ sender: nonAdmin.toString(), signer: localnet.algorand.account.getSigner(nonAdmin) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the registry app', async () => {
      const { testAccount } = localnet.context
      const nonAdmin = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { client } = await deployRegistry(localnet, testAccount)
      await expect(
        client.send.delete.bare({ sender: nonAdmin.toString(), signer: localnet.algorand.account.getSigner(nonAdmin) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('admin can delete the registry app', async () => {
      const { testAccount } = localnet.context
      const { client } = await deployRegistry(localnet, testAccount)
      const sender = testAccount.toString()
      const signer = testAccount.signer
      await expect(client.send.delete.bare({ sender, signer })).resolves.toBeDefined()
    })
  })
})
