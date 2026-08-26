import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { generateAccount, getApplicationAddress } from 'algosdk'
import { MAX_ESCROWS_PER_FD_IMPORT } from 'ggov-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  errAccountNotExists,
  errEscrowNotAssigned,
  errGGovDelegationExists,
  errUnauthorized,
} from '../base/errors.algo'
import {
  createSDK,
  deployFracInstanceWithEscrows,
  deployFracRegistry,
  deployRegistryWithCommittee,
  deployXGovMocksAndRegistry,
  transformedError,
} from '../common-tests'
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

  /**
   * This registry is the single source of truth for fractional-delegation user delegations too, so a
   * frac account (an AlgoQuarters holder, minted by the instance's ingestAq) may delegate here even
   * with no gGov committee membership of its own. The gGov `accounts` box is still checked first;
   * only a miss falls through to a readonly inner call to the frac registry.
   */
  describe('setVotingAccount for fractional-delegation accounts', () => {
    /** A registry + frac registry wired to each other, and one frac-only account (no gGov account). */
    const deployWithFracAccount = async () => {
      const { testAccount: deployer } = localnet.context
      const { sdk } = await deployRegistryWithCommittee(localnet, 1)
      const { sdk: fracSdk, instanceId } = await deployFracInstanceWithEscrows(localnet, [], deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })

      const fracUser = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await fracSdk.registry.writeClient!.send.getOrCreateAccountWithInstance({
        args: { account: fracUser.toString(), instanceNumId: instanceId },
      })
      return { sdk, fracSdk, fracUser }
    }

    test('a frac-only account can set and clear a voting account', async () => {
      const { sdk, fracUser } = await deployWithFracAccount()
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const fracUserSdk = createSDK(localnet, sdk.appId, fracUser)

      await fracUserSdk.setVotingAccount({ votingAddress: votingAddress.toString(), fractionalOnly: true })

      const delegation = await sdk.getDelegation(fracUser.toString())
      expect(delegation.exists).toBe(true)
      expect(delegation.delegatee).toBe(votingAddress.toString())
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([fracUser.toString()])

      // Clearing runs the same delegator gate, so it needs the fallback fee just as much.
      await fracUserSdk.setVotingAccount({ fractionalOnly: true })
      expect((await sdk.getDelegation(fracUser.toString())).exists).toBe(false)
      expect(await sdk.getDelegators(votingAddress.toString())).toEqual([])
    })

    test('an account in neither registry is still rejected', async () => {
      const { sdk } = await deployWithFracAccount()
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // fractionalOnly: the fallback does fire here — it is what reports the miss, so the call has to
      // pay for it to fail on errAccountNotExists rather than on fee.
      await expect(
        createSDK(localnet, sdk.appId, stranger).setVotingAccount({
          votingAddress: votingAddress.toString(),
          fractionalOnly: true,
        }),
      ).rejects.toThrow(transformedError(errAccountNotExists))
    })

    test('the auth rule is unchanged: a stranger cannot manage a frac account delegation', async () => {
      const { sdk, fracUser } = await deployWithFracAccount()
      const stranger = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // The delegator is the frac account, so the fallback fires before the auth check it fails on.
      await expect(
        createSDK(localnet, sdk.appId, stranger).setVotingAccount({
          account: fracUser.toString(),
          votingAddress: votingAddress.toString(),
          fractionalOnly: true,
        }),
      ).rejects.toThrow(transformedError(errUnauthorized))
    })

    test('with no frac registry configured the gGov-only rule still applies', async () => {
      const { testAccount: deployer } = localnet.context
      const { sdk } = await deployRegistryWithCommittee(localnet, 1)
      const { sdk: fracSdk, instanceId } = await deployFracInstanceWithEscrows(localnet, [], deployer)
      // NOTE: no setFracRegistryApp — the registry has no frac pointer to fall back to.
      const fracUser = await localnet.context.generateAccount({ initialFunds: (1).algos() })
      await fracSdk.registry.writeClient!.send.getOrCreateAccountWithInstance({
        args: { account: fracUser.toString(), instanceNumId: instanceId },
      })
      const votingAddress = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      await expect(
        createSDK(localnet, sdk.appId, fracUser).setVotingAccount({ votingAddress: votingAddress.toString() }),
      ).rejects.toThrow(transformedError(errAccountNotExists))
    })
  })

  describe('mirrorXGovDelegation', () => {
    test('refuses to overwrite an existing delegation', async () => {
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 2)
      const [delegator, delegatee] = govAccounts
      await sdk.setXGovRegistryApp({ appId: 12345n })
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

  describe('importFracDelegations', () => {
    test('rejects a batch containing an account that is not a gGov account', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = 3
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 10)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.addr.toString())

      const { sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, escrows, deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })
      const outsider = generateAccount().addr.toString()

      await expect(sdk.importFracDelegations({ escrowAccounts: [...escrows, outsider] })).rejects.toThrow(
        transformedError(errAccountNotExists),
      )
      // Fail-loud batch: the valid escrows in the same call did not land either.
      expect((await sdk.getDelegation(escrows[0])).exists).toBe(false)
      expect((await sdk.getDelegation(escrows[1])).exists).toBe(false)
    })

    test('rejects a batch containing an escrow not registered to any instance', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = 3
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 10)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.addr.toString())
      const { sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, escrows, deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })

      // A real ingested gGov account that was left off the frac instance, so it clears the accounts
      // check and fails on the frac side's zero sentinel instead.
      const unregistered = govAccounts[numEscrows].addr.toString()

      await expect(sdk.importFracDelegations({ escrowAccounts: [...escrows, unregistered] })).rejects.toThrow(
        transformedError(errEscrowNotAssigned),
      )
      // Fail-loud batch: the valid escrows in the same call did not land either.
      expect((await sdk.getDelegation(escrows[0])).exists).toBe(false)
      expect((await sdk.getDelegation(escrows[1])).exists).toBe(false)
    })

    test('SDK refuses a batch over the per-group cap', async () => {
      const { sdk } = await deployRegistryWithCommittee(localnet, 1)
      // The guard is client-side and fires before anything is built, so these addresses never need
      // to exist on either registry — no frac scaffolding required.
      const tooMany = Array.from({ length: MAX_ESCROWS_PER_FD_IMPORT + 1 }, () => generateAccount().addr.toString())

      await expect(sdk.importFracDelegations({ escrowAccounts: tooMany })).rejects.toThrow(
        `Too many escrows to import in one transaction group`,
      )
    })

    test('delegates every escrow to its instance app address', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = 3
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 10)
      const escrows1 = govAccounts.slice(0, numEscrows).map((a) => a.addr.toString())
      const escrows2 = govAccounts.slice(numEscrows, numEscrows * 2).map((a) => a.addr.toString())
      const { sdk: fracSdk, appId: instanceAppId1 } = await deployFracInstanceWithEscrows(localnet, escrows1, deployer)
      const { appId: instanceAppId2 } = await deployFracInstanceWithEscrows(localnet, escrows2, deployer, {
        registrySdk: fracSdk.registry,
      })
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })

      // import call
      await sdk.importFracDelegations({ escrowAccounts: escrows1.concat(escrows2) })

      for (const escrow of escrows1) {
        const delegation = await sdk.getDelegation(escrow)
        expect(delegation.exists).toBe(true)
        expect(delegation.delegatee).toBe(getApplicationAddress(instanceAppId1).toString())
      }
      for (const escrow of escrows2) {
        const delegation = await sdk.getDelegation(escrow)
        expect(delegation.exists).toBe(true)
        expect(delegation.delegatee).toBe(getApplicationAddress(instanceAppId2).toString())
      }
      // Each instance's reverse index lists exactly its own escrows, in import order and with no
      // bleed between them — addReverseDelegation appends, so the order is part of the contract.
      expect(await sdk.getDelegators(getApplicationAddress(instanceAppId1).toString())).toEqual(escrows1)
      expect(await sdk.getDelegators(getApplicationAddress(instanceAppId2).toString())).toEqual(escrows2)
    })

    test('delegates correctly when every escrow sits on its own instance', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = 6
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 10)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.addr.toString())
      const instanceAppIds: bigint[] = []
      const { sdk: fracRegistrySdk } = await deployFracRegistry(localnet, deployer)
      await sdk.setFracRegistryApp({ appId: fracRegistrySdk.appId })
      for (const [i, escrow] of escrows.entries()) {
        const { appId } = await deployFracInstanceWithEscrows(localnet, [escrow], deployer, {
          registrySdk: fracRegistrySdk,
          name: `frac-instance-${i}`,
        })
        instanceAppIds.push(appId)
      }

      await sdk.importFracDelegations({ escrowAccounts: escrows })

      const delegatees = instanceAppIds.map((appId) => getApplicationAddress(appId).toString())
      for (const [i, escrow] of escrows.entries()) {
        expect((await sdk.getDelegation(escrow)).delegatee).toBe(delegatees[i])
        expect(await sdk.getDelegators(delegatees[i])).toEqual([escrow])
      }
    })

    test('re-importing an unchanged delegation is a no-op', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = 2
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, numEscrows)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.toString())
      const { appId, sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, escrows, deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })
      const delegatee = getApplicationAddress(appId).toString()

      await sdk.importFracDelegations({ escrowAccounts: escrows })
      await sdk.importFracDelegations({ escrowAccounts: escrows })

      for (const escrow of escrows) {
        expect((await sdk.getDelegation(escrow)).delegatee).toBe(delegatee)
      }
      // The reverse index did not gain duplicate entries on the second pass.
      expect(await sdk.getDelegators(delegatee)).toEqual(escrows)
    })

    // Contrast with 'refuses to overwrite an existing delegation' above: the two admin delegation
    // writers differ here on purpose.
    test('overwrites an existing delegation, unlike mirrorXGovDelegation', async () => {
      const { testAccount: deployer } = localnet.context
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, 1)
      const [escrowAccount] = govAccounts
      const escrow = escrowAccount.toString()
      const { appId, sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, [escrow], deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })
      const previous = await localnet.context.generateAccount({ initialFunds: (1).algos() })

      // The escrow delegates somewhere else first, through the normal user-facing path.
      await createSDK(localnet, sdk.appId, escrowAccount).setVotingAccount({
        votingAddress: previous.toString(),
      })
      expect((await sdk.getDelegation(escrow)).delegatee).toBe(previous.toString())

      await sdk.importFracDelegations({ escrowAccounts: [escrow] })

      expect((await sdk.getDelegation(escrow)).delegatee).toBe(getApplicationAddress(appId).toString())
      // The previous delegatee's reverse list was unlinked, not left stale.
      expect(await sdk.getDelegators(previous.toString())).toEqual([])
    })

    test('batch-size limit: the log budget, not references, is what caps the batch', async () => {
      const makeRawImportGroup = (appCalls: number) => {
        const builder = sdk.writeClient!.newGroup().importFracDelegations({
          args: { escrowAccounts: escrows },
          extraFee: (escrows.length * 1000).microAlgo(),
        })
        for (let i = 1; i < appCalls; i++) {
          builder.increaseBudget({ args: { itxns: 0 }, note: `raw-import-${appCalls}-${i}` })
        }
        return builder
      }

      // Each escrow emits one GGovDelegationSet: 4-byte ARC-28 selector + 3 addresses = 100 bytes,
      // against the AVM's 1024-byte per-app-call log budget. That budget is per app call, so the
      // ref padding cannot buy more of it - every emit runs inside the one importFracDelegations
      // call. floor(1024/100) = 10, which is where the constant comes from.
      expect(MAX_ESCROWS_PER_FD_IMPORT).toBe(10)

      const { testAccount: deployer } = localnet.context
      const numEscrows = MAX_ESCROWS_PER_FD_IMPORT + 1
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, numEscrows)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.toString())
      const { appId, sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, escrows, deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })
      const delegatee = getApplicationAddress(appId).toString()

      // One over the cap, built raw so the SDK's own guard doesn't pre-empt the chain, and padded
      // to a full group so references are demonstrably not what fails. It still dies on the 11th
      // emit.
      await expect(makeRawImportGroup(15).send()).rejects.toThrow('program logs too large')

      // Exactly at the cap fits.
      await sdk.importFracDelegations({ escrowAccounts: escrows.slice(0, MAX_ESCROWS_PER_FD_IMPORT) })
      for (const escrow of escrows.slice(0, MAX_ESCROWS_PER_FD_IMPORT)) {
        expect((await sdk.getDelegation(escrow)).delegatee).toBe(delegatee)
      }
    }, 300_000)
  })

  describe('importFracDelegationsAll (chunking wrapper)', () => {
    test('splits a list over the cap across groups and lands every escrow', async () => {
      const { testAccount: deployer } = localnet.context
      const numEscrows = MAX_ESCROWS_PER_FD_IMPORT + 3
      const { sdk, govAccounts } = await deployRegistryWithCommittee(localnet, numEscrows)
      const escrows = govAccounts.slice(0, numEscrows).map((a) => a.toString())
      const { appId, sdk: fracSdk } = await deployFracInstanceWithEscrows(localnet, escrows, deployer)
      await sdk.setFracRegistryApp({ appId: fracSdk.registry.appId })
      const delegatee = getApplicationAddress(appId).toString()

      await sdk.importFracDelegationsAll({ escrowAccounts: escrows })

      for (const escrow of escrows) {
        expect((await sdk.getDelegation(escrow)).delegatee).toBe(delegatee)
      }
      expect((await sdk.getDelegators(delegatee)).length).toBe(numEscrows)
    }, 300_000)
  })
})
