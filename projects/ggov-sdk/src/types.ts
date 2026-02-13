import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Address, TransactionSigner } from "algosdk";
import { GGovArgs, GGovComposer } from "./generated/GGovClient";
import { SendSingleTransactionResult, SendAtomicTransactionComposerResults } from "@algorandfoundation/algokit-utils/types/transaction";

export type Network = "mainnet" | "testnet";

export type ConstructorArgsOptions =
  | {
      network: Network;
    }
  | {
      ggovAppId: number | bigint;
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

export interface CommonMethodBuilderArgs {
  builder?: GGovComposer<any>;
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults;

export type GGovContractArgs = GGovArgs["obj"];

export type CommitteeId = Uint8Array | Buffer | string;
