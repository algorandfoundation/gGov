import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getABIDecodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { encodeAddress, makeEmptyTransactionSigner } from "algosdk";
import { XGovCommitteesOracleSDK } from "xgov-committees-oracle-sdk";
import { GGovClient, GGovPeriod, GGovVoteRecord } from "./generated/GGovClient";
import { getConstructorConfig } from "./networkConfig";
import { BodyJson, parseBodyJson, ReaderConstructorArgs, SenderWithSigner } from "./types";
import { chunked } from "./util/chunked";
import { errorTransformer, wrapErrors } from "./util/wrapErrors";
import { SIMULATE_PARAMS } from "xgov-committees-oracle-sdk";

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

  getGlobalState() {
    return this.ggovReadClient.state.global.getAll()
  }

  @wrapErrors()
  async getPeriod(periodId: bigint | number): Promise<GGovPeriod> {
    const { return: period } = await this.ggovReadClient.send.getPeriod({ args: { periodId } });
    return period!;
  }

  @wrapErrors()
  async getVotingRecord(periodId: bigint | number, account: string): Promise<GGovVoteRecord | null> {
    const { return: record } = await this.ggovReadClient.send.getVotingRecord({ args: { periodId, account } });
    if (!record || record.topicVotes.length === 0) return null;
    return record;
  }

  @wrapErrors()
  async getDelegation(account: string): Promise<{ delegatee: string; exists: boolean }> {
    const { return: result } = await this.ggovReadClient.send.getDelegation({ args: { account } });
    return { delegatee: result![0], exists: result![1] };
  }

  @wrapErrors()
  async canVote(periodId: bigint | number, voterAccount: string, senderAccount?: string): Promise<{ canVote: boolean; votingPower: bigint }> {
    const { return: result } = await this.ggovReadClient.send.canVote({
      args: { periodId, voterAccount, senderAccount: senderAccount ?? voterAccount },
    });
    return { canVote: result![0], votingPower: result![1] };
  }

  async getCommitteeIds(): Promise<Uint8Array[]> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId);
    return boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 99 && nameRaw.length === 33)
      .map(({ nameRaw }) => nameRaw.slice(1));
  }

  /** Read the body JSON for a period. Returns null if no body exists or if it fails to parse. */
  async getPeriodBody(periodId: bigint | number): Promise<BodyJson | null> {
    try {
      const key = new Uint8Array(5);
      key[0] = 0x50; // 'P'
      const view = new DataView(key.buffer);
      view.setUint32(1, Number(periodId));
      const raw = await this.algorand.app.getBoxValue(this.appId, key);
      return parseBodyJson(raw);
    } catch {
      return null;
    }
  }

  /** Read the body JSON for a topic. Returns null if no body exists or if it fails to parse. */
  async getTopicBody(periodId: bigint | number, topicIndex: bigint | number): Promise<BodyJson | null> {
    try {
      const key = new Uint8Array(9);
      key[0] = 0x54; // 'T'
      const view = new DataView(key.buffer);
      view.setUint32(1, Number(periodId));
      view.setUint32(5, Number(topicIndex));
      const raw = await this.algorand.app.getBoxValue(this.appId, key);
      return parseBodyJson(raw);
    } catch {
      return null;
    }
  }

  @chunked(128)
  @wrapErrors()
  async getPeriods(periodIds: bigint[]): Promise<GGovPeriod[]> {
    const builder = this.ggovReadClient.newGroup().logPeriods({ args: { periodIds } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "GGovPeriod", this.ggovReadClient.appSpec.structs) as GGovPeriod,
    );
  }

  @chunked(128)
  @wrapErrors()
  async getDelegations(accounts: string[]): Promise<string[]> {
    const builder = this.ggovReadClient.newGroup().logDelegations({ args: { accounts } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "address", this.ggovReadClient.appSpec.structs) as string,
    );
  }

  /** Get all delegations by scanning delegation box keys and batch-fetching delegatees. */
  async getAllDelegations(): Promise<Map<string, string>> {
    const boxNames = await this.algorand.app.getBoxNames(this.appId);
    const accounts = boxNames
      .filter(({ nameRaw }) => nameRaw[0] === 0x64 && nameRaw.length === 33) // 'd' prefix + 32-byte address
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(1)).toString());
    if (accounts.length === 0) return new Map();
    const delegatees = await this.getDelegations(accounts);
    return new Map(accounts.map((account, i) => [account, delegatees[i]]));
  }
}
