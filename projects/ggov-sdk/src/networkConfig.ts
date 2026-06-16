import { Network } from "./types";

const defaultReaderAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";

const networkConfigs: Record<Network, { registryAppId: bigint; readerAccount: string }> = {
  localnet: {
    registryAppId: 1002n,
    readerAccount: defaultReaderAccount,
  },
  testnet: {
    registryAppId: 764235366n,
    readerAccount: defaultReaderAccount,
  },
  mainnet: {
    registryAppId: 0n, // TODO: set after mainnet deployment
    readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
  },
};

export function getNetworkConfig(network: Network) {
  return networkConfigs[network];
}

/**
 * Resolves the registry app id and reader account from constructor args.
 *
 * Accepts either `{ network }` or an explicit app id under any of the accepted
 * field names: `registryAppId` (registry SDK), `ggovRegistryAppId` (proposal SDK),
 * or the deprecated `ggovAppId` alias.
 */
export type ConstructorConfigArgs =
  | { network: Network }
  | { registryAppId: number | bigint; readerAccount?: string }
  | { ggovRegistryAppId: number | bigint; readerAccount?: string }
  /** @deprecated Use ggovRegistryAppId. */
  | { ggovAppId: number | bigint; readerAccount?: string };

export function getConstructorConfig(args: ConstructorConfigArgs): { appId: bigint; readerAccount?: string } {
  if ("network" in args) {
    const config = getNetworkConfig(args.network);
    return { appId: config.registryAppId, readerAccount: config.readerAccount ?? defaultReaderAccount };
  }
  const appIdRaw =
    "registryAppId" in args
      ? args.registryAppId
      : "ggovRegistryAppId" in args
        ? args.ggovRegistryAppId
        : (args as { ggovAppId: number | bigint }).ggovAppId;
  const r = "readerAccount" in args ? args.readerAccount : undefined;
  return { appId: BigInt(appIdRaw), readerAccount: r ?? defaultReaderAccount };
}
