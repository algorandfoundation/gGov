/**
 * Shared environment plumbing for the example scripts.
 *
 * AlgorandClient config comes from the standard AlgoKit environment variables
 * (ALGOD_*, INDEXER_*, KMD_*, DEPLOYER_MNEMONIC). With none set, this targets the
 * default localnet endpoints and the localnet KMD deployer wallet.
 *
 * The registry app id is resolved uniformly: APP_ID wins if set, otherwise the
 * registry created by the DEPLOYER account is located on-chain.
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { Address } from "algosdk";
import { GGovRegistryFactory } from "..";

/** Build an AlgorandClient from the AlgoKit environment variables. */
export function getAlgorand(): AlgorandClient {
  return AlgorandClient.fromEnvironment();
}

/**
 * Resolve the GGovRegistry app id to operate on:
 *   - if APP_ID is set, use it verbatim;
 *   - otherwise locate the registry created by the DEPLOYER account (DEPLOYER_MNEMONIC,
 *     or the localnet KMD deployer wallet).
 *
 * Pass `deployerAddr` to reuse an already-loaded DEPLOYER account; omit it and the
 * account is loaded from the environment only when APP_ID is absent — so read-only
 * callers don't need a deployer when APP_ID pins the target.
 */
export async function resolveRegistryAppId(
  algorand: AlgorandClient,
  deployerAddr?: string | Address,
): Promise<bigint> {
  if (process.env.APP_ID) return BigInt(process.env.APP_ID);

  const creatorAddress = deployerAddr ?? (await algorand.account.fromEnvironment("DEPLOYER")).addr;
  const factory = algorand.client.getTypedAppFactory(GGovRegistryFactory, {
    defaultSender: creatorAddress,
  });
  const { appId } = await factory.getAppClientByCreatorAndName({
    creatorAddress,
    appName: "GGovRegistry",
  });
  return appId;
}
