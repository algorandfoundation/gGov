/** Verbatim copy of ggov-sdk/src/util/txnExecutor.ts */
import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { Algodv2 } from 'algosdk'
import { getIncreaseBudgetBuilder } from './increaseBudget'
import { SendResult, SenderWithSigner } from '../types'

/**
 * Execute a transaction group with automatic budget increase.
 * Shared between the registry SDK and the top-level GGovSDK.
 */
export async function executeTxns<T extends { builder?: any }>({
  txnBuilder,
  txnBuilderArgs,
  emptyGroupBuilder,
  sendParams,
  writerAccount,
  algod,
}: {
  txnBuilder: (args: T) => Promise<any>
  txnBuilderArgs: T
  emptyGroupBuilder: () => any
  sendParams?: SendParams
  writerAccount: SenderWithSigner
  algod: Algodv2
}): Promise<SendResult> {
  let builder = await txnBuilder(txnBuilderArgs)
  const increasedBudgetBuilder = await getIncreaseBudgetBuilder(
    builder,
    emptyGroupBuilder,
    writerAccount.sender.toString(),
    writerAccount.signer,
    algod,
  )
  if (increasedBudgetBuilder) builder = await txnBuilder({ ...txnBuilderArgs, builder: increasedBudgetBuilder })
  return builder.send(sendParams)
}

/**
 * Create a makeTxnExecutor factory bound to a specific SDK instance.
 * Returns a function with the same signature as the per-SDK makeTxnExecutor.
 */
export function createTxnExecutor(
  sdkInstance: object,
  emptyGroupBuilder: () => any,
  wrapErrorsFn: <U>(p: Promise<U>) => Promise<U>,
  getWriterAccount: () => SenderWithSigner | undefined,
  getAlgod: () => Algodv2,
) {
  return <T extends (...args: any) => any, R = SendResult>({
    maker,
    returnTransformer,
    sendParams,
  }: {
    maker: T
    returnTransformer?: (result: SendResult) => R
    sendParams?: SendParams
  }) => {
    return async (args: Omit<Parameters<T>[0], 'builder'>): Promise<R> => {
      const writerAccount = getWriterAccount()
      if (!writerAccount) {
        throw new Error(`writerAccount not set on the SDK instance`)
      }
      const result = await wrapErrorsFn(
        executeTxns({
          txnBuilder: (args) => maker.bind(sdkInstance)(args),
          txnBuilderArgs: args,
          emptyGroupBuilder,
          sendParams,
          writerAccount,
          algod: getAlgod(),
        }),
      )
      if (returnTransformer) {
        return returnTransformer(result)
      }
      return result as R
    }
  }
}
