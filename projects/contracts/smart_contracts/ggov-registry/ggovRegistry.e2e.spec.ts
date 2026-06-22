import { Config } from '@algorandfoundation/algokit-utils'
import { nullLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  calculateCommitteeId,
  increaseBudgetBaseCost,
  increaseBudgetIncrementCost,
  XGovCommitteeFile,
  GGovRegistrySDK,
  GGovRegistryFactory,
  GGovPeriodFactory,
} from 'ggov-sdk'
import {
  errAccountNotExists,
  errAccountOffsetNotExists,
  errCommitteeExists,
  errCommitteeIncomplete,
  errCommitteeNotExists,
  errGGovDelegationExists,
  errIngestedVotesNotZero,
  errNumXGovsExceeded,
  errOutOfOrder,
  errPeriodAppNotConfigured,
  errPeriodEndLessThanStart,
  errPeriodInRange,
  errTotalMembersZero,
  errTotalVotesExceeded,
  errTotalVotesMismatch,
  errTotalVotesZero,
  errTotalXGovsExceeded,
  errUnauthorized,
  errZeroVotes,
} from '../base/errors.algo'
import { committeesForTests } from './fixtures'
import { createSDK, deployRegistry, deployRegistryWithCommittee, deployRegistryWithTwoCommittees, deployXGovMocksAndRegistry, generateAccountWithSDK, transformedError } from '../common-tests'
import committeeTemplate from '../../../common/committee-files/template.json'

describe('GGovRegistry contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    if (process.env.NOOP_TEST_LOGGER === 'true') {
      Config.configure({ logger: nullLogger })
    } else {
      Config.configure({
        debug: true,
        // traceAll: true
       })
      registerDebugEventHandlers()
    }
  })
  beforeEach(localnet.newScope)

  // Infrastructure
  describe('deployment configuration', () => {
    // GGovRegistrySDK.createRegistry() is the production deploy path. It hard-codes
    // extraProgramPages: 3 so the approval program can grow toward the AVM ceiling
    // without ever needing a redeploy. The registry's global schema is declared by the
    // contract itself and sits exactly at the AVM hard cap of 64 (44 uints + 20 bytes);
    // these two assertions guard against either drifting silently on a contract change.
    test('registry deploys with extraProgramPages=3 and a global schema summing to 64', async () => {
      const { testAccount: admin } = localnet.context
      // createRegistry pays the registry MBR + box MBR + initial funding out of the
      // deployer's balance; top the test admin up so it can cover the transfers + fees.
      await localnet.algorand.account.ensureFundedFromEnvironment(admin, (25).algos())
      const { appClient } = await GGovRegistrySDK.createRegistry({
        algorand: localnet.algorand,
        deployer: { sender: admin, signer: localnet.algorand.account.getSigner(admin) },
      })

      const appInfo = await localnet.algorand.app.getById(appClient.appId)
      expect(appInfo.extraProgramPages).toBe(3)
      expect(appInfo.globalInts + appInfo.globalByteSlices).toBe(64)
    })
  })

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


  // Committee lifecycle
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
          xGovs:[xGovsToIngestSorted.at(-1)!, ...xGovsToIngestSorted.slice(0, -1)]
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
      expect(metadata!.ingestedVotes).toBe(committeeFile.totalVotes - committeeFile.xGovs.find((x) => x.address === lastAccount.address)!.votes)
      await expect(
        sdk.readClient.send.getXGovVotingPower({ args: { committeeId, account: lastAccount.address } }),
      ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
    })

    test('uningest from one committee preserves other committee offset', async () => {
      const { sdk, committeeId1, committeeId2, accountA, accountB } = await deployRegistryWithTwoCommittees(localnet)
      await sdk.uningestCommitteeXGovs({ committeeId: committeeId1, accounts: [accountA.toString(), accountB.toString()] })
      const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
        args: { committeeId: committeeId2, account: accountB.toString() },
      })
      expect(votingPower).toBe(10)
      const { return: registryAccount } = await sdk.readClient.send.getAccount({ args: { account: accountB.toString() } })
      expect(registryAccount!.committeeOffsets).toHaveLength(1)
      expect(registryAccount!.committeeOffsets[0][0]).toBe(1)
      const { return: registryAccountA } = await sdk.readClient.send.getAccount({ args: { account: accountA.toString() } })
      expect(registryAccountA!.committeeOffsets).toHaveLength(0)
    })

    test('rejects account not ingested in this committee', async () => {
      const { sdk, committeeId2, accountA } = await deployRegistryWithTwoCommittees(localnet)
      await expect(
        sdk.uningestXGovs({ committeeId: committeeId2, xGovs: [accountA.toString()] }),
      ).rejects.toThrow(transformedError(errAccountOffsetNotExists))
    })

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
      ).rejects.toThrow(transformedError(errAccountNotExists))
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

  describe('uploadCommitteeFile (SDK wrapper)', () => {
    // registerCommittee + ingestXGovs
    for (const [name, id, committeeFile] of committeesForTests) {
      test(`uploads committee ${name}`, async () => {
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
        expect(storedCommittee!.xGovs.length).toEqual(storedCommittee!.totalMembers)
        expect(storedCommittee!.xGovs.reduce((acc, g) => acc + g.votes, 0)).toEqual(storedCommittee!.totalVotes)
      })
    }
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

  describe('getAccount', () => {
    test('getAccount returns GGovAccount with committeeOffsets after ingestion', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet)

      for (const xGov of xGovAccounts) {
        const { return: registryAccount } = await sdk.readClient.send.getAccount({
          args: { account: xGov.toString() },
        })
        expect(registryAccount).toBeDefined()
        expect(registryAccount!.accountId).toBeGreaterThan(0)
        // should have exactly one committee offset entry
        expect(registryAccount!.committeeOffsets).toHaveLength(1)
        // committee numericId should be 0 (first committee)
        expect(registryAccount!.committeeOffsets[0][0]).toBe(0)
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

      // numericId 0 = first committee, numericId 1 = second committee
      const numericIds = registryAccount!.committeeOffsets.map(([cId]) => cId).sort()
      expect(numericIds).toEqual([0, 1])
    })

  })


  // Delegation
  describe('setVotingAccount (xGov-compatible delegation)', () => {
    test('xGov sets their own voting account (account defaults to self) → delegation recorded', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // no `account` arg → defaults to the signer (self)
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })

      const delegation = await sdk.getDelegation(xgov.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(votingAddress.toString())
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([xgov.toString()])
    })

    test('current voting address can re-point the delegation via the `account` arg', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const newVotingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // the current voting address (not the xGov) manages the xGov's delegation
      await createSDK(localnet, sdk.appId, votingAddress).setVotingAccount({
        account: xgov.toString(),
        votingAddress: newVotingAddress.toString(),
      })

      expect((await sdk.getDelegation(xgov.toString())).delegatee).toBe(newVotingAddress.toString())
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
      expect(await sdk.getDelegators(newVotingAddress.toString())).toEqual([xgov.toString()])
    })

    test('current voting address can clear the delegation (omitting votingAddress)', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // delegatee clears the xGov's delegation; omitted votingAddress defaults to the managed account
      await createSDK(localnet, sdk.appId, votingAddress).setVotingAccount({ account: xgov.toString() })

      expect((await sdk.getDelegation(xgov.toString())).exists).toBe(false)
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
    })

    test('setting votingAddress to the zero address clears the delegation', async () => {
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      expect((await sdk.getDelegation(xgov.toString())).exists).toBe(true)

      // votingAddress == ZERO_ADDRESS is treated as "clear", same as omitting it / self-delegation
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: ALGORAND_ZERO_ADDRESS_STRING })

      expect((await sdk.getDelegation(xgov.toString())).exists).toBe(false)
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
    })

    test('xGov can clear their own delegation (undelegate ergonomics: empty args)', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // empty args → manage self, omit target → clear (replaces the former undelegate({}))
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({})
      expect((await sdk.getDelegation(xgov.toString())).exists).toBe(false)
    })

    test('clearing when no delegation exists is a no-op', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({})
      expect((await sdk.getDelegation(xgov.toString())).exists).toBe(false)
    })

    test('unauthorized third party cannot set another account\'s voting account', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        createSDK(localnet, sdk.appId, stranger).setVotingAccount({
          account: xgov.toString(),
          votingAddress: votingAddress.toString(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('cannot set voting account for a non-existent gGov account', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet, 1)
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // stranger manages their own (default-self) delegation but has no gGov account
      await expect(
        createSDK(localnet, sdk.appId, stranger).setVotingAccount({ votingAddress: votingAddress.toString() }),
      ).rejects.toThrow(transformedError(errAccountNotExists))
    })
  })

  describe('mirrorXGovDelegation', () => {
    test('refuses to overwrite an existing delegation', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator, delegatee] = xGovAccounts
      // delegator (a known, ingested account) sets a local gGov delegation
      await createSDK(localnet, sdk.appId, delegator).setVotingAccount({ votingAddress: delegatee.toString() })
      // admin attempting to mirror over the existing delegation must be rejected
      await expect(
        sdk.mirrorXGovDelegation({ account: delegator.toString() }),
      ).rejects.toThrow(transformedError(errGGovDelegationExists))
    })

    test('mirrors an xGov delegation into gGov', async () => {
      const { testAccount } = localnet.context
      const { registryAppClient, ggovRegistrySDK, xGovs } = await deployXGovMocksAndRegistry(localnet, testAccount, 4)
      const [delegator1, delegatee1, delegator2, delegatee2] = xGovs

      const pairs = [
        [delegator1, delegatee1],
        [delegator2, delegatee2],
      ] as const
      for (const [delegator, delegatee] of pairs) {
        await registryAppClient.send.setXGovBox({
          args: {
            voterAddress: delegator.toString(),
            value: { votingAddress: delegatee.toString(), toleratedAbsences: 0n, lastVoteTimestamp: 0n, subscriptionRound: 0n },
          },
        })
        await ggovRegistrySDK.mirrorXGovDelegation({ account: delegator.toString() })
      }

      for (const [delegator, delegatee] of pairs) {
        const delegation = await ggovRegistrySDK.getDelegation(delegator.toString())
        expect(delegation.exists).toBe(true)
        expect(delegation.delegatee).toBe(delegatee.toString())
      }
    })

    test('self-delegation in xGov is skipped (no gGov delegation created)', async () => {
      const { testAccount } = localnet.context
      const { registryAppClient, ggovRegistrySDK, xGovs } = await deployXGovMocksAndRegistry(localnet, testAccount, 1)
      const [delegator] = xGovs

      await registryAppClient.send.setXGovBox({
        args: {
          voterAddress: delegator.toString(),
          value: {
            votingAddress: delegator.toString(),
            toleratedAbsences: 0n,
            lastVoteTimestamp: 0n,
            subscriptionRound: 0n,
          },
        },
      })

      await ggovRegistrySDK.mirrorXGovDelegation({ account: delegator.toString() })

      const delegation = await ggovRegistrySDK.getDelegation(delegator.toString())
      expect(delegation.exists).toBe(false)
    })
  })

  // Period management
  describe('setOperator', () => {
    test('admin can set the operator', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })
      expect(await sdk.readClient.state.global.operator()).toBe(operator.toString())
    })
  })

  describe('createPeriod', () => {
    test('operator can create a period', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      const periodId = await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      expect(periodId).toBeGreaterThan(0n)
    })

    test('rejects mbrPayment sent to wrong receiver', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const wrongPayment = await localnet.algorand.createTransaction.payment({
        sender: testAccount.toString(),
        receiver: testAccount.toString(),
        amount: (1).algos(),
      })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.writeClient!.send.createPeriod({
          args: { committeeId, votingStart: now + 100n, votingEnd: now + 3700n, mbrPayment: wrongPayment },
          sender: testAccount.toString(),
          signer: testAccount.signer,
          extraFee: (3000).microAlgo(),
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-operator cannot create a period', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const { sdk: nonOperatorSDK } = await generateAccountWithSDK(localnet, sdk.appId, (3).algos())
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        nonOperatorSDK.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('rejects nonexistent committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId: new Uint8Array(32), votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('rejects incomplete committee', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setOperator({ account: testAccount.toString() })
      const committeeId = new Uint8Array(32).fill(1)
      await sdk.registerCommittee({
        committeeId,
        periodStart: 50_000_000,
        periodEnd: 53_000_000,
        totalMembers: 1,
        totalVotes: 10,
        xGovRegistryId: 0n,
      })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errCommitteeIncomplete))
    })

    test('rejects votingEnd <= votingStart', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 3700n, votingEnd: now + 100n }),
      ).rejects.toThrow(transformedError(errPeriodEndLessThanStart))
    })

    test('rejects when period approval program not uploaded', async () => {
      const { testAccount } = localnet.context
      await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (25).algos())
      const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const { appClient: bareClient } = await factory.deploy({
        onUpdate: 'append',
        onSchemaBreak: 'append',
        createParams: { extraProgramPages: 3 },
      })
      await localnet.algorand.account.ensureFundedFromEnvironment(bareClient.appAddress, (10).algos())
      const sdk = createSDK(localnet, bareClient.appId, testAccount)
      const xGovAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeId = await sdk.uploadCommitteeFile({
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        xGovs: [{ address: xGovAccount.toString(), votes: 10 }],
      })
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).rejects.toThrow(transformedError(errPeriodAppNotConfigured))
    })
  })

  describe('setLastPeriodId', () => {
    test('admin can set lastPeriodId when no periods exist in the affected range', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setLastPeriodId({ newLastPeriodId: 99n })
      expect(await sdk.readClient.state.global.lastPeriodId()).toBe(99n)
    })

    test('rejects when a period exists in the affected range', async () => {
      const { testAccount } = localnet.context
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n })
      await sdk.addPeriod({ committeeId, votingStart: now + 3800n, votingEnd: now + 7400n })
      await expect(sdk.setLastPeriodId({ newLastPeriodId: 0n })).rejects.toThrow(transformedError(errPeriodInRange))
    })
  })

  describe('uploadPeriodApprovalProgram (SDK wrapper)', () => {
    // chunked upload - uploadPeriodApprovalPartial wrapper
    test('period box assembled via chunks enables createPeriod', async () => {
      const { testAccount } = localnet.context
      // Deploy bare registry (no period bytecode) by bypassing the deployRegistry helper
      await localnet.algorand.account.ensureFundedFromEnvironment(testAccount, (25).algos())
      const factory = localnet.algorand.client.getTypedAppFactory(GGovRegistryFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const { appClient: bareClient } = await factory.deploy({
        onUpdate: 'append',
        onSchemaBreak: 'append',
        createParams: { extraProgramPages: 3 },
      })
      await localnet.algorand.account.ensureFundedFromEnvironment(bareClient.appAddress, (10).algos())
      const sdk = createSDK(localnet, bareClient.appId, testAccount)

      const periodFactory = localnet.algorand.client.getTypedAppFactory(GGovPeriodFactory, {
        defaultSender: testAccount,
        defaultSigner: testAccount.signer,
      })
      const compiled = await periodFactory.appFactory.compile()
      await sdk.uploadPeriodApprovalProgram({ bytecode: compiled.approvalProgram })

      // Verify the box was assembled correctly: createPeriod (addPeriod) must succeed
      const xGovAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        xGovs: [{ address: xGovAccount.toString(), votes: 10 }],
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)
      await sdk.setOperator({ account: testAccount.toString() })
      const now = BigInt(Math.floor(Date.now() / 1000))
      await expect(
        sdk.addPeriod({ committeeId, votingStart: now + 100n, votingEnd: now + 3700n }),
      ).resolves.toBeDefined()
    })
  })

  // Admin & configuration
  describe('setXGovRegistryApp', () => {
    test('admin can set the xGov registry app id', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await sdk.setXGovRegistryApp({ appId: 12345n })
      expect(await sdk.readClient.state.global.xGovRegistryApp()).toBe(12345n)
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
      const { sdk } = await deployRegistry(localnet, testAccount)

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
      const newAdminSDK = createSDK(localnet, sdk.appId, newAdmin)
      await expect(newAdminSDK.setOperator({ account: newAdmin.toString() })).resolves.toBeDefined()
    })

    test('admin can update the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.readClient.send.update.bare({ sender: testAccount.toString(), signer: testAccount.signer })).resolves.toBeDefined()
    })

    test('admin can delete the registry app', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      await expect(sdk.readClient.send.delete.bare({ sender: testAccount.toString(), signer: testAccount.signer })).resolves.toBeDefined()
    })
  })

  describe('withdrawALGO', () => {
    test('admin can withdraw ALGO to a receiver', async () => {
      const { testAccount } = localnet.context
      // deployRegistry funds the app account with 10 ALGO
      const { sdk } = await deployRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      const before = await localnet.algorand.account.getInformation(receiver)
      const registryBefore = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      const amount = (3).algos().microAlgo

      await sdk.withdrawALGO({ receiver: receiver.toString(), amount })

      const after = await localnet.algorand.account.getInformation(receiver)
      const registryAfter = await localnet.algorand.account.getInformation(sdk.readClient.appAddress)
      // Receiver does not pay the fees (sender/admin does), so it gains exactly `amount`.
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo + amount)
      // Registry loses `amount` (the inner-payment fee is paid by the outer txn sender).
      expect(registryAfter.balance.microAlgo).toBe(registryBefore.balance.microAlgo - amount)
    })

    test('withdrawing more than the available balance fails (min balance protected by AVM)', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const receiver = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      // App holds ~10 ALGO; ask for far more than the balance minus min balance.
      await expect(
        sdk.withdrawALGO({ receiver: receiver.toString(), amount: (100).algos().microAlgo }),
      ).rejects.toThrow()
    })
  })

  // Auth
  describe('admin auth', () => {
    let sdk: GGovRegistrySDK
    let nonAdmin: Awaited<ReturnType<typeof localnet.context.generateAccount>>
    let nonAdminSDK: GGovRegistrySDK

    beforeEach(async () => {
      const { testAccount } = localnet.context
      ;({ sdk } = await deployRegistry(localnet, testAccount))
      ;({ account: nonAdmin, sdk: nonAdminSDK } = await generateAccountWithSDK(localnet, sdk.appId))
    })

    test('non-admin cannot unregisterCommittee', async () => {
      await expect(
        nonAdminSDK.unregisterCommittee({ committeeId: new Uint8Array(32) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot registerCommittee', async () => {
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
        nonAdminSDK.ingestXGovs({
          committeeId,
          xGovs: [{ account: nonAdmin.toString(), votes: 10 }],
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot uningestXGovs', async () => {
      const xGovAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const committeeFile: XGovCommitteeFile = {
        ...committeeTemplate,
        totalMembers: 1,
        totalVotes: 10,
        registryId: 0,
        xGovs: [{ address: xGovAccount.toString(), votes: 10 }],
      }
      const committeeId = await sdk.uploadCommitteeFile(committeeFile)
      await expect(
        nonAdminSDK.uningestXGovs({ committeeId, xGovs: [xGovAccount.toString()] }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot mirrorXGovDelegation', async () => {
      const xGovAccount = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        nonAdminSDK.mirrorXGovDelegation({ account: xGovAccount.toString() }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot setAdmin', async () => {
      await expect(nonAdminSDK.setAdmin({ newAdmin: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot withdraw ALGO', async () => {
      await expect(
        nonAdminSDK.withdrawALGO({ receiver: nonAdmin.toString(), amount: (1).algos().microAlgo }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot set the xGov registry app id', async () => {
      await expect(nonAdminSDK.setXGovRegistryApp({ appId: 12345n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot setOperator', async () => {
      await expect(nonAdminSDK.setOperator({ account: nonAdmin.toString() })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot uploadPeriodApprovalPartial', async () => {
      await expect(
        nonAdminSDK.uploadPeriodApprovalPartial({ startOffset: 0n, data: new Uint8Array([0x01]), last: false }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot setLastPeriodId', async () => {
      await expect(nonAdminSDK.setLastPeriodId({ newLastPeriodId: 0n })).rejects.toThrow(
        transformedError(errUnauthorized),
      )
    })

    test('non-admin cannot update the registry app', async () => {
      await expect(
        sdk.readClient.send.update.bare({ sender: nonAdmin.toString(), signer: localnet.algorand.account.getSigner(nonAdmin) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('non-admin cannot delete the registry app', async () => {
      await expect(
        sdk.readClient.send.delete.bare({ sender: nonAdmin.toString(), signer: localnet.algorand.account.getSigner(nonAdmin) }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })
  })
  
  describe('verifyAdmin / verifyOperator', () => {
    test('verifyAdmin returns true for the admin and false for any other account', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const other = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { return: isAdmin } = await sdk.readClient.send.verifyAdmin({ args: { account: testAccount.toString() } })
      expect(isAdmin).toBe(true)
      const { return: isAdminOther } = await sdk.readClient.send.verifyAdmin({ args: { account: other.toString() } })
      expect(isAdminOther).toBe(false)
    })

    test('verifyOperator returns true for the operator and false for any other account', async () => {
      const { testAccount } = localnet.context
      const { sdk } = await deployRegistry(localnet, testAccount)
      const operator = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const other = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await sdk.setOperator({ account: operator.toString() })
      const { return: isOperator } = await sdk.readClient.send.verifyOperator({ args: { account: operator.toString() } })
      expect(isOperator).toBe(true)
      const { return: isOperatorOther } = await sdk.readClient.send.verifyOperator({ args: { account: other.toString() } })
      expect(isOperatorOther).toBe(false)
    })
  })

  // Read methods
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

    test('getXGovVotingPower returns correct votes without offset hint', async () => {
      const { sdk, committeeId, committeeFile, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      for (const xGov of xGovAccounts) {
        const { return: votingPower } = await sdk.readClient.send.getXGovVotingPower({
          args: { committeeId, account: xGov.toString() },
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
      ).rejects.toThrow(transformedError(errAccountNotExists))
    })

    test('tryGetXGovVotingPower returns correct votes for a committee member', async () => {
      const { sdk, committeeId, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const { return: power } = await sdk.readClient.send.tryGetXGovVotingPower({
        args: { committeeId, account: xGovAccounts[0].toString() },
      })
      expect(power).toBe(10)
    })

    test('tryGetXGovVotingPower returns 0 for an unknown account', async () => {
      const { sdk, committeeId } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const { return: power } = await sdk.readClient.send.tryGetXGovVotingPower({
        args: { committeeId, account: unknown.toString() },
      })
      expect(power).toBe(0)
    })

    test('tryGetXGovVotingPower returns 0 for an unknown committee', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const { return: power } = await sdk.readClient.send.tryGetXGovVotingPower({
        args: { committeeId: new Uint8Array(32), account: xGovAccounts[0].toString() },
      })
      expect(power).toBe(0)
    })

    test('getDelegation returns delegatee and exists=true after setVotingAccount', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      const { delegatee, exists } = await sdk.getDelegation(xgov.toString())
      expect(delegatee).toBe(votingAddress.toString())
      expect(exists).toBe(true)
    })

    test('getDelegation returns exists=false for undelegated account', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const { exists } = await sdk.getDelegation(xGovAccounts[0].toString())
      expect(exists).toBe(false)
    })

    test('getDelegate returns the delegatee address after setVotingAccount', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [xgov] = xGovAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, xgov).setVotingAccount({ votingAddress: votingAddress.toString() })
      const { return: delegate } = await sdk.readClient.send.getDelegate({ args: { account: xgov.toString() } })
      expect(delegate).toBe(votingAddress.toString())
    })

    test('getDelegate returns zero address for account with no delegation', async () => {
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const { return: delegate } = await sdk.readClient.send.getDelegate({ args: { account: xGovAccounts[0].toString() } })
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

  describe('SDK reader wrappers', () => {
    test('getGGovAccountsMap returns accountId > 0 for known accounts and 0 for unknown', async () => {
      // logAccounts wrapper: batch-fetches GGovAccount structs via simulate, decodes ABI-encoded log bytes
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const allAddresses = [...xGovAccounts.map((a) => a.toString()), unknown.toString()]
      const accountsMap = await sdk.getGGovAccountsMap(allAddresses)
      for (const xGov of xGovAccounts) {
        expect(accountsMap.get(xGov.toString())!.accountId).toBeGreaterThan(0)
        expect(accountsMap.get(xGov.toString())!.committeeOffsets).toHaveLength(1)
      }
      expect(accountsMap.get(unknown.toString())!.accountId).toBe(0)
      expect(accountsMap.get(unknown.toString())!.committeeOffsets).toHaveLength(0)
    })

    test('getDelegators returns all delegators for the same delegatee', async () => {
      // logDelegators wrapper: simulates log call, decodes one address per log line
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator1, delegator2] = xGovAccounts
      const sharedDelegatee = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await createSDK(localnet, sdk.appId, delegator1).setVotingAccount({ votingAddress: sharedDelegatee.toString() })
      await createSDK(localnet, sdk.appId, delegator2).setVotingAccount({ votingAddress: sharedDelegatee.toString() })
      const delegators = await sdk.getDelegators(sharedDelegatee.toString())
      expect(delegators).toHaveLength(2)
      expect(delegators).toEqual(expect.arrayContaining([delegator1.toString(), delegator2.toString()]))
    })

    test('getDelegators returns empty list for account with no delegators', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 1)
      expect(await sdk.getDelegators(xGovAccounts[0].toString())).toEqual([])
    })

    test('getDelegations returns delegatee per account, zero address for undelegated', async () => {
      // logDelegations wrapper: batch forward lookup, order-preserving
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegated, undelegated] = xGovAccounts
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
      expect(fast!.xGovs).toEqual(normal!.xGovs)
    })

    test('fastGetCommittee throws for non-existent committee', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet)
      await expect(sdk.fastGetCommittee(new Uint8Array(32))).rejects.toThrow(transformedError(errCommitteeNotExists))
    })

    test('getCommitteeXGovs returns all xGovs with correct votes', async () => {
      const { sdk, committeeId, committeeFile } = await deployRegistryWithCommittee(localnet)
      const xGovs = await sdk.getCommitteeXGovs(committeeId)
      expect(xGovs).toHaveLength(committeeFile.totalMembers)
      expect(xGovs.reduce((acc, { votes }) => acc + votes, 0)).toBe(committeeFile.totalVotes)
    })

    test('getXGovVotingPowers returns votes for member and 0 for non-member', async () => {
      // tryGetXGovVotingPower wrapper: batches power lookups via simulate group
      const { sdk, committeeId, xGovAccounts } = await deployRegistryWithCommittee(localnet)
      const unknown = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const memberPowers = await sdk.getXGovVotingPowers([committeeId], xGovAccounts[0].toString())
      expect(memberPowers[0]).toBeGreaterThan(0)
      const unknownPowers = await sdk.getXGovVotingPowers([committeeId], unknown.toString())
      expect(unknownPowers[0]).toBe(0)
    })

    test('getCommitteeIds returns all registered committee IDs', async () => {
      const { sdk, committeeId1, committeeId2 } = await deployRegistryWithTwoCommittees(localnet)
      const ids = await sdk.getCommitteeIds()
      expect(ids).toHaveLength(2)
      expect(ids.map((id) => Buffer.from(id).toString('base64'))).toEqual(
        expect.arrayContaining([Buffer.from(committeeId1).toString('base64'), Buffer.from(committeeId2).toString('base64')]),
      )
    })

    test('getAllDelegations returns map of all active delegations', async () => {
      const { sdk, xGovAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator1, delegator2] = xGovAccounts
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
})
