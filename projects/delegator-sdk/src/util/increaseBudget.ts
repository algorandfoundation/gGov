import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { modelsv2, TransactionSigner, Algodv2, makeEmptyTransactionSigner } from 'algosdk'
import { DelegatorComposer } from '../generated/DelegatorClient'
import { increaseBudgetBaseCost, increaseBudgetIncrementCost } from '../constants'

export const SIMULATE_PARAMS = {
  allowMoreLogging: true,
  allowUnnamedResources: true,
  extraOpcodeBudget: 130013,
  fixSigners: true,
  allowEmptySignatures: true,
}

const simulateRequest = new modelsv2.SimulateRequest({
  txnGroups: [],
  ...SIMULATE_PARAMS,
})

/* Utility to increase the budget of a transaction group if needed.
 * Simulates and returns undefines if we are under budget, otherwise returns a new builder with an increaseBudget call prepended.
 */
export async function getIncreaseBudgetBuilder<T extends DelegatorComposer<any>>(
  builder: T,
  newBuilderFactory: () => T,
  sender: string,
  signer: TransactionSigner | TransactionSignerAccount,
  algod: Algodv2,
): Promise<T | undefined> {
  // console.log("Increasing budget");

  // maxFee/coverAppCallInnerTransactionFees does not work with builder.simulate() #algokit
  // increase first txn's fee so we do not fail because of fees
  // get atc & modify the first txn fee (need to clone to make txns mutable)
  const atc = (await (await builder.composer()).build()).atc.clone()
  // @ts-expect-error private and readonly
  atc.transactions[0].txn.fee = 256_000n // 256x min fee

  // we also need to replace signers with empty signers for simulation
  // otherwise end users would be prompted to sign for this
  // @ts-expect-error private and readonly
  atc.transactions = atc.transactions.map((t) => {
    t.signer = makeEmptyTransactionSigner()
    return t
  })

  const {
    simulateResponse: {
      txnGroups: [{ txnResults, appBudgetConsumed = 0 }],
    },
  } = await atc.simulate(algod, simulateRequest)

  // intentionally doing opup even if there is a failure
  // we had code here to return early if there was a failureMessage
  // but that meant that in some cases the actual failure would be obscured by out of budget errors

  // get existing budget: count OUTER app calls
  // inner app calls can not be relied upon fully
  // because their budget is added at call time
  // TODO FUTURE optimistic inner check, fallback to outer count
  // TODO FUTURE add app call if refs are missing - currently increaseBudget addition is load bearing in some cases
  // (single vote app call does not have enough ref slots to go through without increaseBudget, succeeds only as a side effect)
  const numAppCalls = txnResults.filter(({ txnResult }) => txnResult?.txn.txn.type === 'appl').length

  let existingBudget = 700 * numAppCalls

  // budget is OK, returning
  if (appBudgetConsumed! <= existingBudget) return

  existingBudget += 700 - increaseBudgetBaseCost // add 700 for increaseBudget, removing its base cost
  const itxnBudgetNeeded = appBudgetConsumed! - existingBudget // budget to create in itxns

  const itxns = Math.max(0, Math.ceil(itxnBudgetNeeded / (700 - increaseBudgetIncrementCost))) // base cost - no iterations

  // console.log(JSON.stringify({ appBudgetConsumed, existingBudget, itxnBudgetNeeded, itxns }));

  const increaseBudgetArgs = {
    args: { itxns },
    extraFee: (itxns * 1000).microAlgo(),
    maxFee: ((itxns + 1) * 1000).microAlgo(),
    note: getNonce().toString(),
    sender,
    signer,
  }

  return newBuilderFactory().increaseBudget(increaseBudgetArgs) as T
}

function getNonce() {
  return Math.floor(Math.random() * 100_000_000)
}
