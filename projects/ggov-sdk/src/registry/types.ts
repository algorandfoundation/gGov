import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Address } from "algosdk";
import { GGovRegistryArgs, GGovRegistryComposer } from "../generated/GGovRegistryClient";
import { Network, SenderWithSigner } from "../types";

// Re-export shared primitives so existing imports from this module keep working.
export type { Network, SenderWithSigner, SendResult, CommitteeId } from "../types";

export type ConstructorArgsOptions =
  | {
      network: Network;
    }
  | {
      registryAppId: number | bigint;
      readerAccount?: string;
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

export interface CommonMethodBuilderArgs {
  builder?: GGovRegistryComposer<any>
}

export type GGovRegistryContractArgs = GGovRegistryArgs["obj"];
