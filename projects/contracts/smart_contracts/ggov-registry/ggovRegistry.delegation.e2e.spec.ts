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

    test("unauthorized third party cannot set another account's voting account", async () => {
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
      await expect(sdk.mirrorXGovDelegation({ account: delegator.toString() })).rejects.toThrow(
        transformedError(errGGovDelegationExists),
      )
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
})
