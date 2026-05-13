import { ConstructorArgsOptions } from "./types";

export type Network = "mainnet" | "testnet";

const defaultReaderAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";

const networkConfigs: Record<Network, { registryAppId: bigint; readerAccount: string }> = {
  mainnet: {
    registryAppId: 1013n,
    readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
  },
  testnet: {
    registryAppId: 1014n,
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
    return { appId: config.registryAppId, readerAccount: config.readerAccount ?? defaultReaderAccount };
  } else {
    const { registryAppId, readerAccount: r } = args;
    return { appId: BigInt(registryAppId), readerAccount: r ?? defaultReaderAccount };
  }
}
