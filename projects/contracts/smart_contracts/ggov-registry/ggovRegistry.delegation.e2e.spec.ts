import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { errAccountNotExists, errGGovDelegationExists, errUnauthorized } from '../base/errors.algo'
import { createSDK, deployRegistryWithCommittee, deployXGovMocksAndRegistry, transformedError } from '../common-tests'
import { configureTestLogging } from '../test-utils'

describe('GGovRegistry delegation', () => {
  const localnet = algorandFixture()

  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('setVotingAccount (xGov-compatible delegation)', () => {
    test('gov sets their own voting account (account defaults to self) → delegation recorded', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // no `account` arg → defaults to the signer (self)
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })

      const delegation = await sdk.getDelegation(gov.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(votingAddress.toString())
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([gov.toString()])
    })

    test('current voting address can re-point the delegation via the `account` arg', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const newVotingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // the current voting address (not the gov) manages the gov's delegation
      await createSDK(localnet, sdk.appId, votingAddress).setVotingAccount({
        account: gov.toString(),
        votingAddress: newVotingAddress.toString(),
      })

      expect((await sdk.getDelegation(gov.toString())).delegatee).toBe(newVotingAddress.toString())
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
      expect(await sdk.getDelegators(newVotingAddress.toString())).toEqual([gov.toString()])
    })

    test('current voting address can clear the delegation (omitting votingAddress)', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // delegatee clears the gov's delegation; omitted votingAddress defaults to the managed account
      await createSDK(localnet, sdk.appId, votingAddress).setVotingAccount({ account: gov.toString() })

      expect((await sdk.getDelegation(gov.toString())).exists).toBe(false)
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
    })

    test('setting votingAddress to the zero address clears the delegation', async () => {
      const { ALGORAND_ZERO_ADDRESS_STRING } = await import('algosdk')
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      expect((await sdk.getDelegation(gov.toString())).exists).toBe(true)

      // votingAddress == ZERO_ADDRESS is treated as "clear", same as omitting it / self-delegation
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: ALGORAND_ZERO_ADDRESS_STRING })

      expect((await sdk.getDelegation(gov.toString())).exists).toBe(false)
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
    })

    test('gov can clear their own delegation (undelegate ergonomics: empty args)', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await createSDK(localnet, sdk.appId, gov).setVotingAccount({ votingAddress: votingAddress.toString() })
      // empty args → manage self, omit target → clear (replaces the former undelegate({}))
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({})
      expect((await sdk.getDelegation(gov.toString())).exists).toBe(false)
    })

    test('clearing when no delegation exists is a no-op', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      await createSDK(localnet, sdk.appId, gov).setVotingAccount({})
      expect((await sdk.getDelegation(gov.toString())).exists).toBe(false)
    })

    test("unauthorized third party cannot set another account's voting account", async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [gov] = govAccounts
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await expect(
        createSDK(localnet, sdk.appId, stranger).setVotingAccount({
          account: gov.toString(),
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
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator, delegatee] = govAccounts
      // delegator (a known, ingested account) sets a local gGov delegation
      await createSDK(localnet, sdk.appId, delegator).setVotingAccount({ votingAddress: delegatee.toString() })
      // admin attempting to mirror over the existing delegation must be rejected
      await expect(sdk.mirrorXGovDelegation({ account: delegator.toString() })).rejects.toThrow(
        transformedError(errGGovDelegationExists),
      )
    })

    test('mirrors an xGov delegation into gGov', async () => {
      const { testAccount } = localnet.context
      const { registryAppClient, ggovRegistrySDK, govs } = await deployXGovMocksAndRegistry(localnet, testAccount, 4)
      const [delegator1, delegatee1, delegator2, delegatee2] = govs

      const pairs = [
        [delegator1, delegatee1],
        [delegator2, delegatee2],
      ] as const
      for (const [delegator, delegatee] of pairs) {
        await registryAppClient.send.setXGovBox({
          args: {
            voterAddress: delegator.toString(),
            value: {
              votingAddress: delegatee.toString(),
              toleratedAbsences: 0n,
              lastVoteTimestamp: 0n,
              subscriptionRound: 0n,
            },
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
      const { registryAppClient, ggovRegistrySDK, govs } = await deployXGovMocksAndRegistry(localnet, testAccount, 1)
      const [delegator] = govs

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
})
