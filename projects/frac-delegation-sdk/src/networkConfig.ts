import { Network } from './types'

const defaultReaderAccount = 'A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE'

const networkConfigs: Record<Network, { registryAppId: bigint; readerAccount: string }> = {
  localnet: {
    registryAppId: 0n, // TODO: set when a deterministic localnet deploy exists
    readerAccount: defaultReaderAccount,
  },
  testnet: {
    registryAppId: 0n, // TODO: set after testnet deployment
    readerAccount: defaultReaderAccount,
  },
  mainnet: {
    registryAppId: 0n, // TODO: set after mainnet deployment
    readerAccount: 'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA',
  },
}

export function getNetworkConfig(network: Network) {
  return networkConfigs[network]
}

/**
 * Resolves the frac registry app id and reader account from constructor args:
 * either `{ network }` or an explicit `{ registryAppId }`.
 */
export type ConstructorConfigArgs = { network: Network } | { registryAppId: number | bigint; readerAccount?: string }

export function getConstructorConfig(args: ConstructorConfigArgs): { appId: bigint; readerAccount?: string } {
  if ('network' in args) {
    const config = getNetworkConfig(args.network)
    return { appId: config.registryAppId, readerAccount: config.readerAccount ?? defaultReaderAccount }
  }
  return { appId: BigInt(args.registryAppId), readerAccount: args.readerAccount ?? defaultReaderAccount }
}
