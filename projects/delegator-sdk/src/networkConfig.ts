import { ConstructorArgsOptions } from './types'

export type Network = 'mainnet' | 'testnet'

const defaultReaderAccount = 'A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE'

const networkConfigs: Record<Network, { delegatorAppId: bigint; readerAccount: string }> = {
  mainnet: {
    delegatorAppId: 1013n,
    readerAccount: 'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA',
  },
  testnet: {
    delegatorAppId: 1014n,
    readerAccount: defaultReaderAccount,
  },
}

export function getNetworkConfig(network: Network) {
  return networkConfigs[network]
}

export function getConstructorConfig(args: ConstructorArgsOptions): { appId: bigint; readerAccount?: string } {
  if ('network' in args) {
    const { network } = args
    const config = getNetworkConfig(network)
    return { appId: config.delegatorAppId, readerAccount: config.readerAccount ?? defaultReaderAccount }
  } else {
    const { delegatorAppId: delegatorAppId, readerAccount: r } = args
    return { appId: BigInt(delegatorAppId), readerAccount: r ?? defaultReaderAccount }
  }
}
