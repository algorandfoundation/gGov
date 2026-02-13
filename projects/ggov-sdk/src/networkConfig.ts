import { ConstructorArgsOptions } from "./types";

export type Network = "mainnet" | "testnet";

const defaultReaderAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";

const networkConfigs: Record<Network, { ggovAppId: bigint; readerAccount: string }> = {
  mainnet: {
    ggovAppId: 0n, // TODO: set after deployment
    readerAccount: defaultReaderAccount,
  },
  testnet: {
    ggovAppId: 0n, // TODO: set after deployment
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
    return { appId: config.ggovAppId, readerAccount: config.readerAccount ?? defaultReaderAccount };
  } else {
    const { ggovAppId, readerAccount: r } = args;
    return { appId: BigInt(ggovAppId), readerAccount: r ?? defaultReaderAccount };
  }
}
