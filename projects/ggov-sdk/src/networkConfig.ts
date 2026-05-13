import { ConstructorArgsOptions } from "./types";

export type Network = "mainnet" | "testnet";

const defaultReaderAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";

const networkConfigs: Record<Network, { ggovRegistryAppId: bigint; readerAccount: string }> = {
  mainnet: {
    ggovRegistryAppId: 0n, // TODO: set after deployment
    readerAccount: defaultReaderAccount,
  },
  testnet: {
    ggovRegistryAppId: 0n, // TODO: set after deployment
    readerAccount: defaultReaderAccount,
  },
};

export function getNetworkConfig(network: Network) {
  return networkConfigs[network];
}

export function getConstructorConfig(args: ConstructorArgsOptions): { appId: bigint; readerAccount?: string } {
  if ("network" in args) {
    const { network } = args;
    const config = getNetworkConfig(network);
    return { appId: config.ggovRegistryAppId, readerAccount: config.readerAccount ?? defaultReaderAccount };
  }
  // Normalise: accept both ggovRegistryAppId (new) and ggovAppId (deprecated alias)
  const appIdRaw = "ggovRegistryAppId" in args ? args.ggovRegistryAppId : (args as { ggovAppId: number | bigint }).ggovAppId;
  const r = "readerAccount" in args ? args.readerAccount : undefined;
  return { appId: BigInt(appIdRaw), readerAccount: r ?? defaultReaderAccount };
}
