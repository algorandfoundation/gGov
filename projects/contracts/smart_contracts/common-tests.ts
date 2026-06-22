import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { Account, Address } from 'algosdk'
import {
  calculateCommitteeId,
  GGovRegistrySDK,
  XGovCommitteeFile,
} from 'ggov-sdk'
import { XGovDelegatorSDK } from 'xgov-delegator-sdk'
import committeeTemplate from '../../common/committee-files/template.json'
import { DelegatorFactory } from './artifacts/delegator/DelegatorClient'
import { XGovProposalMockClient, XGovProposalMockComposer } from './artifacts/xgov-proposal-mock/XGovProposalMockClient'
import { XGovRegistryMockFactory } from './artifacts/xgov-registry-mock/XGovRegistryMockClient'
import { STATUS_SUBMITTED } from './xgov-proposal-mock/xGovProposalMock.algo'

async function lastBlockTimestamp(algorand: AlgorandClient): Promise<number> {
  const { algod } = algorand.client
  const { lastRound } = await algod.status().do()
  const {
    block: {
      header: { timestamp },
    },
  } = await algod.block(lastRound).headerOnly(true).do()
  return Number(timestamp)
}

export function transformedError(errCode: string) {
  return errCode.replace('ERR:', 'Error ')
}

export const deployRegistry = async (localnet: AlgorandFixture, account: Address, firstPeriodId?: bigint | number) => {
  // Deploy through the production path (GGovRegistrySDK.createRegistry) so every test exercises the
  // real deploy config: extraProgramPages: 3, global schema at the AVM cap, and the GGovPeriod
  // approval bytecode uploaded. createRegistry pays the registry MBR + initial funding out of
  // the deployer's balance, so top `account` up first (the app address is funded internally).
  await localnet.algorand.account.ensureFundedFromEnvironment(account, (25).algos())
  const signer = localnet.algorand.account.getSigner(account)

  const { sdk, appClient } = await GGovRegistrySDK.createRegistry({
    algorand: localnet.algorand,
    deployer: { sender: account, signer },
    firstPeriodId,
  })

  return {
    client: appClient,
    sdk,
  }
}

export const createSDK = (localnet: AlgorandFixture, registryAppId: bigint, account: Address) =>
  new GGovRegistrySDK({
    algorand: localnet.algorand,
    registryAppId,
    writerAccount: { sender: account, signer: localnet.algorand.account.getSigner(account) },
  })

export const generateAccountWithSDK = async (localnet: AlgorandFixture, registryAppId: bigint, initialFunds = (1).algos()) => {
  const account = await localnet.context.generateAccount({ initialFunds })
  return { account, sdk: createSDK(localnet, registryAppId, account) }
}

async function createCommittee(
  localnet: AlgorandFixture,
  registryAppId: bigint,
  totalMembers: number,
  votesPerMember: number,
): Promise<{ committee: XGovCommitteeFile; xGovs: (Address & Account & TransactionSignerAccount)[] }> {
  const xGovs = await Promise.all(
    Array.from({ length: totalMembers }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committee: XGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers,
    totalVotes: totalMembers * votesPerMember,
    registryId: Number(registryAppId),
    xGovs: xGovs.map((a) => ({
      address: a.toString(),
      votes: votesPerMember,
    })),
  }

  return { committee, xGovs }
}

export async function configureProposal(args: {
  proposalAppClient: XGovProposalMockClient
  committee?: XGovCommitteeFile
  status?: number
  voteOpenTs?: number
  votingDuration?: number
}) {
  const { proposalAppClient, ...rest } = args
  const { committee, status, voteOpenTs, votingDuration } = rest
  console.log('Configuring proposal', rest)
  const builder: XGovProposalMockComposer<any> = proposalAppClient.newGroup()
  if (committee !== undefined) {
    builder.setCommitteeId({
      args: { committeeId: calculateCommitteeId(JSON.stringify(committee)) },
    })
  }
  if (status !== undefined) {
    builder.setStatus({ args: { status } })
  }
  if (voteOpenTs !== undefined) {
    builder.setVoteOpenTs({ args: { voteOpenTs } })
  }
  if (votingDuration !== undefined) {
    builder.setVotingDuration({ args: { votingDuration } })
  }
  await builder.send()
}

export const deployXGovMocksAndRegistry = async (localnet: AlgorandFixture, adminAccount: Address, numXGovs: number) => {
  const factory = localnet.algorand.client.getTypedAppFactory(XGovRegistryMockFactory, {
    defaultSender: adminAccount,
  })

  const { appClient: registryAppClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

  await localnet.algorand.account.ensureFundedFromEnvironment(registryAppClient.appAddress, (10).algos())

  const { return: proposalAppId } = await registryAppClient.send.createProposal({
    args: {},
    extraFee: (2000).microAlgo(),
  })
  const proposalAppClient = new XGovProposalMockClient({
    algorand: localnet.algorand,
    appId: proposalAppId!,
    defaultSender: adminAccount,
  })

  const { committee, xGovs } = await createCommittee(localnet, registryAppClient.appId, numXGovs, 1)
  const proposalConfigPromise = configureProposal({
    proposalAppClient,
    committee,
    status: STATUS_SUBMITTED,
    voteOpenTs: await lastBlockTimestamp(localnet.algorand),
    votingDuration: 3600, // 1 hour
  })

  const { sdk: ggovRegistrySDK } = await deployRegistry(localnet, adminAccount)
  await ggovRegistrySDK.uploadCommitteeFile(committee)
  await ggovRegistrySDK.setXGovRegistryApp({ appId: registryAppClient.appId })
  await proposalConfigPromise

  return { registryAppClient, proposalAppClient, ggovRegistrySDK, committee, xGovs }
}

export const deployRegistryWithCommittee = async (localnet: AlgorandFixture, numXGovs = 3, votesPerMember = 10) => {
  const { testAccount } = localnet.context
  const xGovAccounts = await Promise.all(
    Array.from({ length: numXGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committeeFile: XGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: numXGovs,
    totalVotes: numXGovs * votesPerMember,
    registryId: 0,
    xGovs: xGovAccounts.map((a) => ({
      address: a.toString(),
      votes: votesPerMember,
    })),
  }
  const { sdk } = await deployRegistry(localnet, testAccount)
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)
  // get sorted order by account ID (ingestion order)
  const accountIdMap = await sdk.getAccountIdMap(xGovAccounts.map((a) => a.toString()))
  const sorted = Array.from(accountIdMap.entries())
    .map(([address, id]) => ({ address, id }))
    .sort((a, b) => a.id - b.id)
  return { sdk, committeeId, committeeFile, xGovAccounts, sorted }
}

export const deployRegistryWithTwoCommittees = async (localnet: AlgorandFixture, votesPerMember = 10) => {
  const { testAccount } = localnet.context
  // 3 accounts: A, B, C. Committee 1 has A+B, committee 2 has B+C. B is shared.
  const xGovAccounts = await Promise.all(
    Array.from({ length: 3 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const [accountA, accountB, accountC] = xGovAccounts

  const committee1File: XGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: 2,
    totalVotes: 2 * votesPerMember,
    registryId: 0,
    xGovs: [accountA, accountB].map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }
  const committee2File: XGovCommitteeFile = {
    ...committeeTemplate,
    periodStart: committeeTemplate.periodStart + 3_000_000,
    periodEnd: committeeTemplate.periodEnd + 3_000_000,
    totalMembers: 2,
    totalVotes: 2 * votesPerMember,
    registryId: 0,
    xGovs: [accountB, accountC].map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }

  const { sdk } = await deployRegistry(localnet, testAccount)
  const committeeId1 = await sdk.uploadCommitteeFile(committee1File)
  const committeeId2 = await sdk.uploadCommitteeFile(committee2File)

  return { sdk, committeeId1, committeeId2, committee1File, committee2File, accountA, accountB, accountC }
}

export const deployDelegatorFull = async (
  localnet: AlgorandFixture,
  adminAccount: Address,
  numXGovs: number,
  numSugDelegators: number,
) => {
  const { proposalAppClient, registryAppClient, ggovRegistrySDK, committee, xGovs } = await deployXGovMocksAndRegistry(
    localnet,
    adminAccount,
    numXGovs,
  )
  const { adminSDK, userSDK } = await deployDelegatorSimple(localnet, adminAccount, xGovs[0])

  await adminSDK.setCommitteeOracleApp({ appId: ggovRegistrySDK.appId })

  const subDelegators = await Promise.all(
    Array.from({ length: numSugDelegators }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )

  await Promise.all([
    adminSDK.addAccountAlgoHours({
      accountAlgohours: subDelegators.map((account) => ({ account: account.toString(), algoHours: 100n })),
      periodStart: committee.periodStart,
    }),
    adminSDK.addAccountAlgoHours({
      accountAlgohours: subDelegators.map((account) => ({ account: account.toString(), algoHours: 100n })),
      periodStart: committee.periodStart + 1_000_000,
    }),
    adminSDK.addAccountAlgoHours({
      accountAlgohours: subDelegators.map((account) => ({ account: account.toString(), algoHours: 100n })),
      periodStart: committee.periodStart + 2_000_000,
    }),
  ])

  await Promise.all(
    Array.from({ length: 3 }, (_, idx) =>
      adminSDK.updateAlgoHourPeriodFinality({
        periodStart: committee.periodStart + idx * 1_000_000,
        final: true,
        totalAlgohours: BigInt(subDelegators.length * 100),
      }),
    ),
  )

  return {
    delegatorAdminSDK: adminSDK,
    delegatorUserSDK: userSDK,
    ggovRegistrySDK,
    registryAppClient,
    proposalAppClient,
    committee,
    xGovs,
    subDelegators,
  }
}

export const deployDelegatorSimple = async (
  localnet: AlgorandFixture,
  adminAccount: Address,
  userAccount?: Address,
) => {
  const factory = localnet.algorand.client.getTypedAppFactory(DelegatorFactory, {
    defaultSender: adminAccount,
  })

  const { appClient } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

  await localnet.algorand.account.ensureFundedFromEnvironment(appClient.appAddress, (10).algos())

  const sender = adminAccount
  const signer = localnet.algorand.account.getSigner(sender)

  const retVal: { client: typeof appClient; adminSDK: XGovDelegatorSDK; userSDK?: XGovDelegatorSDK } = {
    client: appClient,
    adminSDK: new XGovDelegatorSDK({
      algorand: localnet.algorand,
      delegatorAppId: appClient.appId,
      writerAccount: { sender, signer },
      debug: false,
    }),
  }

  if (userAccount) {
    const userSigner = localnet.algorand.account.getSigner(userAccount)
    retVal.userSDK = new XGovDelegatorSDK({
      algorand: localnet.algorand,
      delegatorAppId: appClient.appId,
      writerAccount: { sender: userAccount, signer: userSigner },
      debug: false,
    })
  }

  return retVal
}
