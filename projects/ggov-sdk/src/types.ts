import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Address, TransactionSigner } from "algosdk";
import { GGovRegistryArgs, GGovRegistryComposer } from "./generated/GGovRegistryClient";
import { GGovPeriodArgs, GGovPeriodComposer } from "./generated/GGovPeriodClient";
import { SendSingleTransactionResult, SendAtomicTransactionComposerResults } from "@algorandfoundation/algokit-utils/types/transaction";

export type Network = "mainnet" | "testnet";

export type ConstructorArgsOptions =
  | {
      network: Network;
    }
  | {
      ggovRegistryAppId: number | bigint;
      readerAccount?: string;
    }
  /** @deprecated Use ggovRegistryAppId. Kept for backward compatibility. */
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
  builder?: GGovRegistryComposer<any>;
  /** Optional transaction note. Useful for deduplicating otherwise-identical transactions. */
  note?: string | Uint8Array;
}

export interface PeriodMethodBuilderArgs {
  builder?: GGovPeriodComposer<any>;
  /** Optional transaction note. */
  note?: string | Uint8Array;
}

export type SendResult = SendSingleTransactionResult | SendAtomicTransactionComposerResults;

export type GGovRegistryContractArgs = GGovRegistryArgs["obj"];
export type GGovPeriodContractArgs = GGovPeriodArgs["obj"];

export type CommitteeId = Uint8Array | Buffer | string;

/** Schema for period and topic body JSON stored on-chain */
export interface BodyJson {
  title: string;
  body: string;
}

export function validateBodyJson(obj: unknown): obj is BodyJson {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as any).title === "string" &&
    typeof (obj as any).body === "string"
  );
}

export function parseBodyJson(raw: Uint8Array): BodyJson | null {
  try {
    const text = new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    if (validateBodyJson(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
