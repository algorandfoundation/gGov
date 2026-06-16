import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { GGovRegistryArgs, GGovRegistryComposer } from "../generated/GGovRegistryClient";
import { GGovPeriodArgs, GGovPeriodComposer } from "../generated/GGovPeriodClient";
import { Network, SenderWithSigner } from "../types";

// Re-export shared primitives so the public surface is unchanged.
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

export type GGovRegistryContractArgs = GGovRegistryArgs["obj"];
export type GGovPeriodContractArgs = GGovPeriodArgs["obj"];

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
