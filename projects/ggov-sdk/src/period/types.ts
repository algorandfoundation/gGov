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
  /**
   * Present only on election-type periods: the number of seats being elected
   * (a positive integer). Absent on non-election periods.
   */
  electThresh?: number;
}

export function validateBodyJson(obj: unknown): obj is BodyJson {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.body !== "string") return false;
  if (
    o.electThresh !== undefined &&
    (typeof o.electThresh !== "number" || !Number.isInteger(o.electThresh) || o.electThresh < 1)
  ) {
    return false;
  }
  return true;
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
