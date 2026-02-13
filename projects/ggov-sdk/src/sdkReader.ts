import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getABIDecodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { makeEmptyTransactionSigner } from "algosdk";
import { XGovCommitteesOracleSDK } from "xgov-committees-oracle-sdk";
import { GGovClient, GGovPeriod, GGovVoteRecord } from "./generated/GGovClient";
import { getConstructorConfig } from "./networkConfig";
import { ReaderConstructorArgs, SenderWithSigner } from "./types";
import { errorTransformer, wrapErrors } from "./util/wrapErrors";
import { SIMULATE_PARAMS } from "./util/increaseBudget";

export class GGovReaderSDK extends XGovCommitteesOracleSDK {
  public ggovReadClient: GGovClient;

  constructor({ algorand, concurrency = 4, debug, writerAccount, ...rest }: ReaderConstructorArgs & { writerAccount?: SenderWithSigner }) {
    const { appId, readerAccount } = getConstructorConfig(rest);
    // Pass through to oracle SDK with oracleAppId (same app, since gGov IS the oracle)
    super({ algorand, concurrency, debug, oracleAppId: appId, readerAccount, writerAccount });
    algorand.registerErrorTransformer(errorTransformer);
    this.ggovReadClient = new GGovClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    });
  }

  @wrapErrors()
  async getPeriod(periodId: bigint | number): Promise<GGovPeriod> {
    const { return: period } = await this.ggovReadClient.send.getPeriod({ args: { periodId } });
    return period!;
  }

  @wrapErrors()
  async getVotingRecord(periodId: bigint | number, account: string): Promise<GGovVoteRecord> {
    const { return: record } = await this.ggovReadClient.send.getVotingRecord({ args: { periodId, account } });
    return record!;
  }

  @wrapErrors()
  async getDelegation(account: string): Promise<{ delegatee: string; exists: boolean }> {
    const { return: result } = await this.ggovReadClient.send.getDelegation({ args: { account } });
    return { delegatee: result![0], exists: result![1] };
  }

  @wrapErrors()
  async canVote(periodId: bigint | number, voterAccount: string, sender?: string): Promise<{ canVote: boolean; votingPower: bigint }> {
    const { return: result } = await this.ggovReadClient.send.canVote({
      args: { periodId, voterAccount },
      ...(sender ? { sender } : {}),
    });
    return { canVote: result![0], votingPower: result![1] };
  }

  @wrapErrors()
  async logPeriods(periodIds: bigint[]): Promise<GGovPeriod[]> {
    const builder = this.ggovReadClient.newGroup().logPeriods({ args: { periodIds } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "GGovPeriod", this.ggovReadClient.appSpec.structs) as GGovPeriod,
    );
  }
}
