import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { GGovReaderSDK } from 'ggov-sdk'
import { EscregSDK } from '@d13co/escreg-sdk'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'

/**
 * Reader-side SDK construction shared by the GGovSDKProvider (client) and the
 * route loaders (server, during SSR). Reads are wallet-independent and run over
 * algod/indexer HTTP, so the exact same code path works in the browser and in
 * the Cloudflare Worker. Keeping one builder here means the loader and the
 * provider can never drift on app IDs or client config.
 */

export const registryAppId = BigInt(import.meta.env.VITE_GGOV_REGISTRY_APP_ID || '0')

export const escregAppId = import.meta.env.VITE_ESCREG_APP_ID
  ? BigInt(import.meta.env.VITE_ESCREG_APP_ID)
  : undefined

// `tokenOverride` lets the Cloudflare Worker authenticate to Algod with a
// privileged, server-only secret (see serverReaderSdk.ts) instead of the public
// VITE_ALGOD_TOKEN that ships in the browser bundle. The browser keeps passing
// nothing here, so it uses the public config token unchanged.
export function createAlgorandClient(tokenOverride?: string) {
  const config = getAlgodConfigFromViteEnvironment()
  return AlgorandClient.fromConfig({
    algodConfig: {
      server: config.server,
      port: config.port,
      token: tokenOverride ?? config.token,
    },
  }).setDefaultValidityWindow(213) // ~10 mins at 2.81 round times
}

export function createReaderSDK(tokenOverride?: string) {
  return new GGovReaderSDK({ algorand: createAlgorandClient(tokenOverride), registryAppId, concurrency: 8 })
}

export function createEscregSDK() {
  // App-escrow lookups are read-only and wallet-independent. When VITE_ESCREG_APP_ID
  // is set we query that deployment through the app's own Algorand client; otherwise
  // the SDK falls back to its built-in Fnet registry (escrow addresses are
  // network-independent, derived purely from the app ID).
  if (escregAppId !== undefined) {
    return new EscregSDK({ appId: escregAppId, algorand: createAlgorandClient() })
  }
  return new EscregSDK({})
}
