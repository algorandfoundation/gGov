import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getABIDecodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { makeEmptyTransactionSigner } from "algosdk";
import { getConstructorConfig } from "./networkConfig";
import { CommitteeId, DelegatorContractArgs, DelegatorGlobalState, ReaderConstructorArgs } from "./types";
import { errorTransformer, wrapErrors } from "./util/wrapErrors";
import { AlgohourPeriodTotals, DelegatorClient, DelegatorComposer, DelegatorCommittee, DelegatorProposal } from "./generated/DelegatorClient";
import { chunk } from "./util/chunk";
import { chunked } from "./util/chunked";
import { SIMULATE_PARAMS } from "./util/increaseBudget";
import { committeeIdToRaw } from "./util/comitteeId";

export class XGovDelegatorReaderSDK {
  public algorand: AlgorandClient;
  public appId: bigint;
  public readClient: DelegatorClient;
  public concurrency: number;
  public debug?: boolean;

  constructor({ algorand, concurrency = 4, debug, ...rest }: ReaderConstructorArgs) {
    const { appId, readerAccount } = getConstructorConfig(rest);
    this.algorand = algorand;
    algorand.setSuggestedParamsCacheTimeout(6000); // 6s or ~2 rounds of cache. reduces GET requests to /params
    algorand.registerErrorTransformer(errorTransformer);
    this.appId = appId;
    this.concurrency = concurrency;
    this.debug = debug;
    this.readClient = new DelegatorClient({
      algorand: this.algorand,
      appId: this.appId,
      defaultSender: readerAccount,
      defaultSigner: makeEmptyTransactionSigner(),
    });
  }

  async getGlobalState(): Promise<DelegatorGlobalState> {
    const state = await this.readClient.state.global.getAll();
    if (!state) {
      throw new Error(`Failed to fetch global state for appId ${this.appId}`);
    }
    return state as DelegatorGlobalState
  }

  @wrapErrors()
  async getAccountAlgoHours({ periodStart, account }: DelegatorContractArgs["getAccountAlgoHours(uint64,address)uint64"]): Promise<bigint> {
    const { return: retVal } = await this.readClient.send.getAccountAlgoHours({ args: { account, periodStart } })
    return retVal!
  }

  @wrapErrors()
  async getAlgoHourPeriodTotals({ periodStart }: DelegatorContractArgs["getAlgoHourPeriodTotals(uint64)(uint64,bool)"]): Promise<AlgohourPeriodTotals> {
    const { return: retVal } = await this.readClient.send.getAlgoHourPeriodTotals({ args: { periodStart } })
    return retVal!
  }

  async getCommitteeMetadata(committeeIds: CommitteeId[]): Promise<DelegatorCommittee[]> {
    return this._getCommitteeMetadataChunked(committeeIds.map(committeeIdToRaw));
  }

  @chunked(128)
  private async _getCommitteeMetadataChunked(committeeIds: Uint8Array[]): Promise<DelegatorCommittee[]> {
    if (committeeIds.length === 0) return [];
    const committeeIdChunks = chunk(committeeIds, 63);
    let builder: DelegatorComposer<any> = this.readClient.newGroup();
    for (const committeeIdChunk of committeeIdChunks) {
      builder = builder.logCommitteeMetadata({ args: { committeeIds: committeeIdChunk } });
    }
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs ?? []);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "DelegatorCommittee", this.readClient.appSpec.structs) as DelegatorCommittee
    );
  }

  async getProposalMetadata(proposalIds: (bigint | number)[]): Promise<DelegatorProposal[]> {
    return this._getProposalMetadataChunked(proposalIds.map(BigInt));
  }

  @chunked(128)
  private async _getProposalMetadataChunked(proposalIds: bigint[]): Promise<DelegatorProposal[]> {
    if (proposalIds.length === 0) return [];
    const builder = this.readClient.newGroup().logProposalMetadata({ args: { proposalIds } });
    const { confirmations } = await builder.simulate(SIMULATE_PARAMS);
    const logs = confirmations.flatMap(({ logs }) => logs ?? []);
    return logs.map((log) =>
      getABIDecodedValue(new Uint8Array(log!), "DelegatorProposal", this.readClient.appSpec.structs) as DelegatorProposal
    );
  }
}
