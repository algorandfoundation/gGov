import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { calculateCommitteeId, XGovCommitteeFile, GGovRegistrySDK } from 'ggov-sdk'
import { XGovDelegatorSDK } from 'xgov-delegator-sdk'
import { XGovProposalMockClient } from '../artifacts/xgov-proposal-mock/XGovProposalMockClient'
import { errCommitteeNotExists, errState } from '../base/errors.algo'
import { configureProposal, deployDelegatorFull, transformedError } from '../common-tests'
import { configureTestLogging } from '../test-utils'
import { STATUS_EMPTY } from '../xgov-proposal-mock/xGovProposalMock.algo'

describe.skip('Delegator complex e2e tests', () => {
  const localnet = algorandFixture()
  beforeAll(configureTestLogging)
  beforeEach(localnet.newScope)

  describe('Scenario 1', () => {
    let adminAccount: Address & TransactionSignerAccount & Account
    let committee: XGovCommitteeFile
    let delegatorAdminSDK: XGovDelegatorSDK
    let delegatorUserSDK: XGovDelegatorSDK | undefined
    let ggovRegistrySDK: GGovRegistrySDK
    let proposalAppClient: XGovProposalMockClient
    let registryAppClient: Awaited<ReturnType<typeof deployDelegatorFull>>['registryAppClient']
    let xGovs: (Address & Account & TransactionSignerAccount)[]

    beforeEach(async () => {
      await localnet.newScope()
      const { testAccount } = localnet.context
      adminAccount = testAccount
      ;({ committee, delegatorAdminSDK, delegatorUserSDK, ggovRegistrySDK, proposalAppClient, registryAppClient, xGovs } =
        await deployDelegatorFull(localnet, adminAccount, 3, 6))
    })

    async function syncCommitteeMetadata() {
      const committeeId = calculateCommitteeId(JSON.stringify(committee))
      const committeeWithOffsets = await ggovRegistrySDK.fastGetCommittee(committeeId, { includeBoxOrder: true })
      const delegatedAccounts = committeeWithOffsets!.xGovBoxOrder!
      await delegatorAdminSDK.syncCommitteeMetadata({ committeeId, delegatedAccounts })
      console.log('Synced committee metadata')
    }

    test('It should syncCommitteeMetadata', async () => {
      await syncCommitteeMetadata()
    })

    test('It should syncProposalMetadata', async () => {
      await syncCommitteeMetadata()
      console.log('Syncing proposal metadata')
      await delegatorAdminSDK.syncProposalMetadata({
        proposalId: proposalAppClient.appId,
      })
    })

    test('It should not syncProposalMetadata without synced committee', async () => {
      await expect(
        delegatorAdminSDK.syncProposalMetadata({
          proposalId: proposalAppClient.appId,
        }),
      ).rejects.toThrowError(transformedError(errCommitteeNotExists))
    })

    test('It should not syncProposalMetadata at invalid proposal state', async () => {
      await syncCommitteeMetadata()
      await configureProposal({
        proposalAppClient,
        status: STATUS_EMPTY,
      })
      await expect(
        delegatorAdminSDK.syncProposalMetadata({
          proposalId: proposalAppClient.appId,
        }),
      ).rejects.toThrowError(transformedError(errState))
    })
  })
})
