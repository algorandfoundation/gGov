import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { DelegatorClient, DelegatorComposer } from './generated/DelegatorClient'
import { XGovDelegatorReaderSDK } from './sdkReader'
import {
  AccountWithAlgoHours,
  CommitteeId,
  CommonMethodBuilderArgs,
  ConstructorArgs,
  DelegatorContractArgs,
  SenderWithSigner,
  SendResult,
} from './types'
import { getIncreaseBudgetBuilder } from './util/increaseBudget'
import { requireWriter } from './util/requiresSender'
import { wrapErrors, wrapErrorsInternal } from './util/wrapErrors'
import { accountWithAlgoHoursToTuple } from './util/types'
import { committeeIdToRaw } from './util/comitteeId'

export class XGovDelegatorSDK extends XGovDelegatorReaderSDK {
  public writerAccount?: SenderWithSigner
  public writeClient?: DelegatorClient

  constructor({ writerAccount, ...rest }: ConstructorArgs) {
    super(rest)
    if (writerAccount) {
      this.writerAccount = writerAccount
      this.writeClient = new DelegatorClient({
        algorand: this.algorand,
        appId: this.appId,
        defaultSender: writerAccount?.sender,
        defaultSigner: writerAccount?.signer,
      })
    }
  }

  // Create an executor from a makeXYZTxn function
  private makeTxnExecutor = <T extends (...args: any) => any, R = SendResult>({
    maker,
    returnTransformer,
    sendParams,
  }: {
    maker: T
    returnTransformer?: (result: SendResult) => R
    sendParams?: SendParams
  }) => {
    return async (args: Omit<Parameters<T>[0], 'builder'>): Promise<R> => {
      if (!this.writerAccount) {
        throw new Error(`writerAccount not set on the SDK instance`)
      }
      const result = await wrapErrorsInternal(
        this.execute({
          txnBuilder: (args) => maker.bind(this)(args),
          txnBuilderArgs: args,
          emptyGroupBuilder: () => this.writeClient!.newGroup(),
          sendParams,
        }),
      )
      if (returnTransformer) {
        return returnTransformer(result)
      }
      return result as R
    }
  }

  // Utility to handle increaseBudget automatically and wrap algod errors
  // gets a standalone group without opup
  // test if need to prepend increaseBudget()
  // if so, remake group with emptyGroupBuilder, passing in a group with increaseBudget() prepended
  private async execute<T extends CommonMethodBuilderArgs, Y extends DelegatorComposer<any>>({
    txnBuilder,
    txnBuilderArgs,
    emptyGroupBuilder,
    sendParams,
  }: {
    txnBuilder: (args: T) => Promise<Y>
    txnBuilderArgs: T
    emptyGroupBuilder: () => Y
    sendParams?: SendParams
  }) {
    let builder = await txnBuilder(txnBuilderArgs)
    const increasedBudgetBuilder = await getIncreaseBudgetBuilder(
      builder,
      emptyGroupBuilder,
      this.writerAccount!.sender.toString(),
      this.writerAccount!.signer,
      this.algorand.client.algod,
    )
    if (increasedBudgetBuilder) builder = await txnBuilder({ ...txnBuilderArgs, builder: increasedBudgetBuilder })
    return builder.send(sendParams)
  }

  @requireWriter()
  @wrapErrors()
  makeSetCommitteeOracleApp({
    appId,
    builder,
  }: DelegatorContractArgs['setCommitteeOracleApp(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setCommitteeOracleApp({ args: { appId } })
    return builder
  }

  setCommitteeOracleApp = this.makeTxnExecutor({
    maker: this.makeSetCommitteeOracleApp,
  })

  @requireWriter()
  @wrapErrors()
  makeSyncCommitteeMetadata({
    committeeId,
    delegatedAccounts,
    builder,
  }: Omit<
    DelegatorContractArgs['syncCommitteeMetadata(byte[32],address[])(uint32,uint32,uint32,(uint32,uint32)[])'],
    'committeeId'
  > & { committeeId: CommitteeId } & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    const inners = 1 + delegatedAccounts.length
    builder = builder.syncCommitteeMetadata({
      args: { committeeId: committeeIdToRaw(committeeId), delegatedAccounts },
      extraFee: (inners * 1000).microAlgo(),
    })
    return builder
  }

  syncCommitteeMetadata = this.makeTxnExecutor({
    maker: this.makeSyncCommitteeMetadata,
  })

  @requireWriter()
  @wrapErrors()
  makeAddAccountAlgoHours({
    periodStart,
    accountAlgohours,
    builder,
  }: Omit<DelegatorContractArgs['addAccountAlgoHours(uint64,(address,uint64)[])void'], 'accountAlgohourInputs'> & {
    accountAlgohours: AccountWithAlgoHours[]
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    const accountAlgohourInputs = accountAlgohours.map(accountWithAlgoHoursToTuple)
    // TODO count refs, chunk call
    builder = builder.addAccountAlgoHours({ args: { periodStart, accountAlgohourInputs } })
    return builder
  }

  addAccountAlgoHours = this.makeTxnExecutor({
    maker: this.makeAddAccountAlgoHours,
  })

  @requireWriter()
  @wrapErrors()
  makeRemoveAccountAlgoHours({
    periodStart,
    accountAlgohours,
    builder,
  }: Omit<DelegatorContractArgs['removeAccountAlgoHours(uint64,(address,uint64)[])void'], 'accountAlgohourInputs'> & {
    accountAlgohours: AccountWithAlgoHours[]
  } & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    const accountAlgohourInputs = accountAlgohours.map(accountWithAlgoHoursToTuple)
    // TODO count refs, chunk call
    builder = builder.removeAccountAlgoHours({ args: { periodStart, accountAlgohourInputs } })
    return builder
  }

  removeAccountAlgoHours = this.makeTxnExecutor({
    maker: this.makeRemoveAccountAlgoHours,
  })

  @requireWriter()
  @wrapErrors()
  makeSetVoteSubmitThreshold({
    threshold,
    builder,
  }: DelegatorContractArgs['setVoteSubmitThreshold(uint64)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setVoteSubmitThreshold({ args: { threshold } })
    return builder
  }

  setVoteSubmitThreshold = this.makeTxnExecutor({
    maker: this.makeSetVoteSubmitThreshold,
  })

  @requireWriter()
  @wrapErrors()
  makeSetAbsenteeMode({
    mode,
    builder,
  }: DelegatorContractArgs['setAbsenteeMode(string)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.setAbsenteeMode({ args: { mode } })
    return builder
  }

  setAbsenteeMode = this.makeTxnExecutor({
    maker: this.makeSetAbsenteeMode,
  })

  @requireWriter()
  @wrapErrors()
  makeSyncProposalMetadata({
    proposalId,
    builder,
  }: DelegatorContractArgs['syncProposalMetadata(uint64)(string,byte[32],uint32,uint32,uint32,(uint32,uint32)[],(uint32,uint32)[],uint32,uint64,uint64,uint64,uint64,uint64,uint64)'] &
    CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.syncProposalMetadata({ args: { proposalId } })
    return builder
  }

  syncProposalMetadata = this.makeTxnExecutor({
    maker: this.makeSyncProposalMetadata,
  })

  @requireWriter()
  @wrapErrors()
  makeUpdateAlgoHourPeriodFinality({
    periodStart,
    totalAlgohours,
    final,
    builder,
  }: DelegatorContractArgs['updateAlgoHourPeriodFinality(uint64,uint64,bool)void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.updateAlgoHourPeriodFinality({ args: { periodStart, totalAlgohours, final } })
    return builder
  }

  updateAlgoHourPeriodFinality = this.makeTxnExecutor({
    maker: this.makeUpdateAlgoHourPeriodFinality,
  })

  @requireWriter()
  @wrapErrors()
  makeVoteInternal({
    proposalId,
    voterAccount,
    vote,
    builder,
  }: DelegatorContractArgs['voteInternal(uint64,address,(uint64,uint64,uint64,uint64))void'] &
    CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.voteInternal({ args: { proposalId, voterAccount, vote } })
    return builder
  }

  voteInternal = this.makeTxnExecutor({
    maker: this.makeVoteInternal,
  })

  @requireWriter()
  @wrapErrors()
  makeVoteExternal({
    proposalId,
    extAccounts,
    builder,
  }: DelegatorContractArgs['voteExternal(uint64,address[])void'] & CommonMethodBuilderArgs) {
    builder = builder ?? this.writeClient!.newGroup()
    builder = builder.voteExternal({ args: { proposalId, extAccounts } })
    return builder
  }

  voteExternal = this.makeTxnExecutor({
    maker: this.makeVoteExternal,
  })
}
