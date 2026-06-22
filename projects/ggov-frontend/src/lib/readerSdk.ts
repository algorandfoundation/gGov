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

// TODO(backend-client): the SSR route loaders run this in the Cloudflare Worker,
// where every render makes an algod round-trip on a public VITE_ALGOD_* config
// (the token is bundled into the client too, so it can't be privileged or rate-
// limited per-origin). Isolate a backend-only Algorand client built from a
// server-only secret (e.g. a non-VITE ALGOD_TOKEN bound via wrangler, read from
// the Worker env — NOT import.meta.env) and have the loaders use that, keeping
// this browser builder for the GGovSDKProvider. Until then loaders share the
// public client below.
export function createAlgorandClient() {
  const config = getAlgodConfigFromViteEnvironment()
  return AlgorandClient.fromConfig({
    algodConfig: {
      server: config.server,
      port: config.port,
      token: config.token,
    },
  }).setDefaultValidityWindow(213) // ~10 mins at 2.81 round times
}

export function createReaderSDK() {
  return new GGovReaderSDK({ algorand: createAlgorandClient(), registryAppId, concurrency: 8 })
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
