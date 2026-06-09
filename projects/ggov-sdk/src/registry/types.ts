import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Account, Address, TransactionSigner } from "algosdk";
import { GGovRegistryArgs, GGovRegistryComposer } from "../generated/GGovRegistryClient";
import { SendSingleTransactionResult, SendAtomicTransactionComposerResults } from "@algorandfoundation/algokit-utils/types/transaction";

export type Network = "mainnet" | "testnet";

export type ConstructorArgsOptions =
  | {
      network: Network;
    }
  | {
      registryAppId: number | bigint;
      readerAccount?: string;
    };

export type SenderWithSigner = {
  sender: Address | string;
  signer: TransactionSigner;
};

export type ConstructorArgs = {
  writerAccount?: SenderWithSigner;
} & ReaderConstructorArgs;

export type ReaderConstructorArgs = {
  algorand: AlgorandClient;
  concurrency?: number;
  debug?: boolean;
} & ConstructorArgsOptions;

export interface XGovCommitteeFile {
  networkGenesisHash: string;
  periodEnd: number;
  periodStart: number;
  registryId: number;
  totalMembers: number;
  totalVotes: number;
  xGovs: Array<{
    address: string;
    votes: number;
  }>;
}

export type AccountWithVotes = {
  account: Address | string
  votes: number
}

type ID = number
type Votes = number
export type StoredXGov = [ID, Votes]
export const STORED_XGOV_BYTE_LENGTH = 8; // 4 bytes for ID + 4 bytes for Votes

export type CommitteeId = Uint8Array | Buffer | string

export interface CommonMethodBuilderArgs {
  builder?: GGovRegistryComposer<any>
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults

export type GGovRegistryContractArgs = GGovRegistryArgs["obj"];
