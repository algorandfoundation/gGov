import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { Account, Address } from 'algosdk'
import { FracDelegationSDK, FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { calculateCommitteeId, GGovRegistrySDK, GGovCommitteeFile } from 'ggov-sdk'
import committeeTemplate from '../../common/committee-files/template.json'
import { XGovProposalMockClient, XGovProposalMockComposer } from './artifacts/xgov-proposal-mock/XGovProposalMockClient'
import { XGovRegistryMockFactory } from './artifacts/xgov-registry-mock/XGovRegistryMockClient'
import { STATUS_SUBMITTED } from './xgov-proposal-mock/xGovProposalMock.algo'

// --------------------------------------------------------------------
// COMMON
// --------------------------------------------------------------------

const lastBlockTimestamp = async (algorand: AlgorandClient): Promise<number> => {
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

// --------------------------------------------------------------------
// GGOV REGISTRY: create SDK, generate account with SDK
// --------------------------------------------------------------------

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

export const deployRegistryWithCommittee = async (localnet: AlgorandFixture, numGovs = 3, votesPerMember = 10) => {
  const { testAccount } = localnet.context
  const govAccounts = await Promise.all(
    Array.from({ length: numGovs }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committeeFile: GGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: numGovs,
    totalVotes: numGovs * votesPerMember,
    registryId: 0,
    govs: govAccounts.map((a) => ({
      address: a.toString(),
      votes: votesPerMember,
    })),
  }
  const { sdk } = await deployRegistry(localnet, testAccount)
  const committeeId = await sdk.uploadCommitteeFile(committeeFile)
  // get sorted order by account ID (ingestion order)
  const accountIdMap = await sdk.getAccountIdMap(govAccounts.map((a) => a.toString()))
  const sorted = Array.from(accountIdMap.entries())
    .map(([address, id]) => ({ address, id }))
    .sort((a, b) => a.id - b.id)
  return { sdk, committeeId, committeeFile, govAccounts, sorted }
}

export const deployRegistryWithTwoCommittees = async (localnet: AlgorandFixture, votesPerMember = 10) => {
  const { testAccount } = localnet.context
  // 3 accounts: A, B, C. Committee 1 has A+B, committee 2 has B+C. B is shared.
  const govAccounts = await Promise.all(
    Array.from({ length: 3 }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const [accountA, accountB, accountC] = govAccounts

  const committee1File: GGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers: 2,
    totalVotes: 2 * votesPerMember,
    registryId: 0,
    govs: [accountA, accountB].map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }
  const committee2File: GGovCommitteeFile = {
    ...committeeTemplate,
    periodStart: committeeTemplate.periodStart + 3_000_000,
    periodEnd: committeeTemplate.periodEnd + 3_000_000,
    totalMembers: 2,
    totalVotes: 2 * votesPerMember,
    registryId: 0,
    govs: [accountB, accountC].map((a) => ({ address: a.toString(), votes: votesPerMember })),
  }

  const { sdk } = await deployRegistry(localnet, testAccount)
  const committeeId1 = await sdk.uploadCommitteeFile(committee1File)
  const committeeId2 = await sdk.uploadCommitteeFile(committee2File)

  return { sdk, committeeId1, committeeId2, committee1File, committee2File, accountA, accountB, accountC }
}

// --------------------------------------------------------------------
// GGOV REGISTRY: deploy helpers
// --------------------------------------------------------------------

export const createSDK = (localnet: AlgorandFixture, registryAppId: bigint, account: Address) =>
  new GGovRegistrySDK({
    algorand: localnet.algorand,
    registryAppId,
    writerAccount: { sender: account, signer: localnet.algorand.account.getSigner(account) },
  })

export const generateAccountWithSDK = async (
  localnet: AlgorandFixture,
  registryAppId: bigint,
  initialFunds = (1).algos(),
) => {
  const account = await localnet.context.generateAccount({ initialFunds })
  return { account, sdk: createSDK(localnet, registryAppId, account) }
}

// --------------------------------------------------------------------
// FRAC REGISTRY: create SDK, generate account with SDK
// --------------------------------------------------------------------

export const createFracRegistrySDK = (localnet: AlgorandFixture, registryAppId: bigint, account: Address) =>
  new FracDelegationRegistrySDK({
    algorand: localnet.algorand,
    registryAppId,
    writerAccount: { sender: account, signer: localnet.algorand.account.getSigner(account) },
  })

export const generateAccountWithFracRegSDK = async (
  localnet: AlgorandFixture,
  registryAppId: bigint,
  initialFunds = (1).algos(),
) => {
  const account = await localnet.context.generateAccount({ initialFunds })
  return { account, sdk: createFracRegistrySDK(localnet, registryAppId, account) }
}

// --------------------------------------------------------------------
// FRAC REGISTRY: deploy helpers
// --------------------------------------------------------------------

export const deployFracRegistry = async (localnet: AlgorandFixture, account: Address) => {
  // Analogous to deployRegistry
  await localnet.algorand.account.ensureFundedFromEnvironment(account, (25).algos())
  const signer = localnet.algorand.account.getSigner(account)

  const { sdk, appClient } = await FracDelegationRegistrySDK.createRegistry({
    algorand: localnet.algorand,
    deployer: { sender: account, signer },
  })

  return {
    client: appClient,
    sdk,
  }
}

// --------------------------------------------------------------------
// FRAC COMPOSED: create SDK, generate account with SDK
// --------------------------------------------------------------------

export const createFracDelegationSDK = (localnet: AlgorandFixture, registryAppId: bigint, account: Address) =>
  new FracDelegationSDK({
    algorand: localnet.algorand,
    registryAppId,
    writerAccount: { sender: account, signer: localnet.algorand.account.getSigner(account) },
  })

export const generateAccountWithFracSDK = async (
  localnet: AlgorandFixture,
  registryAppId: bigint,
  initialFunds = (1).algos(),
) => {
  const account = await localnet.context.generateAccount({ initialFunds })
  return { account, sdk: createFracDelegationSDK(localnet, registryAppId, account) }
}

// --------------------------------------------------------------------
// FRAC INSTANCE: deploy helpers
// --------------------------------------------------------------------

export const deployFracInstance = async (
  localnet: AlgorandFixture,
  account: Address,
  opts: {
    /** Instance label passed to addInstance */
    name?: string
    /** Spawn from this registry instead of deploying a fresh one (its writer must be the registry admin); the returned sdk still signs as `account`) */
    registrySdk?: FracDelegationRegistrySDK
    /** Set as the registry's defaultOperator before spawning */
    defaultOperator?: Address
  } = {},
) => {
  // Spawn an instance via addInstance - the production path
  const { name = 'frac-instance', defaultOperator } = opts
  const registrySdk = opts.registrySdk ?? (await deployFracRegistry(localnet, account)).sdk
  if (defaultOperator !== undefined) {
    await registrySdk.setDefaultOperator({ newDefaultOperator: defaultOperator.toString() })
  }
  const instanceId = await registrySdk.addInstance({ name })
  const sdk = createFracDelegationSDK(localnet, registrySdk.appId, account)
  const appId = await sdk.getInstanceAppId(instanceId)

  return { appId, instanceId, sdk }
}

export const deployFracInstanceWithEscrows = async (
  localnet: AlgorandFixture,
  escrows: string[],
  account?: Address,
  opts: {
    /** Instance label passed to addInstance */
    name?: string
    /** Spawn from this registry instead of deploying a fresh one (its writer must be the registry admin); the returned sdk still signs as `account`) */
    registrySdk?: FracDelegationRegistrySDK
    /** Set as the registry's defaultOperator before spawning */
    defaultOperator?: Address
  } = {},
) => {
  const testAccount = account ?? localnet.context.testAccount
  const { sdk, instanceId, appId } = await deployFracInstance(localnet, testAccount, opts)
  for (const escrow of escrows) {
    await sdk.registry.registerEscrow({ instanceNumId: instanceId, account: escrow })
  }

  return { appId, instanceId, sdk }
}

// --------------------------------------------------------------------
// XGOV HELPERS
// --------------------------------------------------------------------

export const configureXGovProposal = async (args: {
  proposalAppClient: XGovProposalMockClient
  committee?: GGovCommitteeFile // it's xgov committee file, but we don't have a separate type
  status?: number
  voteOpenTs?: number
  votingDuration?: number
}) => {
  const { proposalAppClient, ...rest } = args
  const { committee, status, voteOpenTs, votingDuration } = rest
  if (process.env.NOOP_TEST_LOGGER !== 'true') {
    console.log('Configuring proposal', rest)
  }
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

const createXGovCommittee = async (
  localnet: AlgorandFixture,
  registryAppId: bigint,
  totalMembers: number,
  votesPerMember: number,
): Promise<{ committee: GGovCommitteeFile; xGovs: (Address & Account & TransactionSignerAccount)[] }> => {
  const xGovs = await Promise.all(
    Array.from({ length: totalMembers }, () => localnet.context.generateAccount({ initialFunds: (1).algos() })),
  )
  const committee: GGovCommitteeFile = {
    ...committeeTemplate,
    totalMembers,
    totalVotes: totalMembers * votesPerMember,
    registryId: Number(registryAppId),
    govs: xGovs.map((a) => ({
      address: a.toString(),
      votes: votesPerMember,
    })),
  }

  return { committee, xGovs }
}

export const deployXGovMocksAndRegistry = async (localnet: AlgorandFixture, adminAccount: Address, numGovs: number) => {
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

  const { committee, xGovs } = await createXGovCommittee(localnet, registryAppClient.appId, numGovs, 1)
  const proposalConfigPromise = configureXGovProposal({
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

  return { registryAppClient, proposalAppClient, ggovRegistrySDK, committee, govs: xGovs }
}
