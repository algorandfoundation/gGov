import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { XGovProposalMockFactory } from '../artifacts/xgov-proposal-mock/XGovProposalMockClient'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log('\nNot deploying XGovProposalMock, disabled in deploy-config.ts')
  return

  console.log('\n=== Deploying XGovProposal ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(XGovProposalMockFactory, {
    defaultSender: deployer.addr,
  })

  await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
}
