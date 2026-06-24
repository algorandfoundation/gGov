import { createIsomorphicFn } from '@tanstack/react-start'
import { createReaderSDK, type AlgodOverrides } from './readerSdk'

/**
 * Reader SDK for the SSR route loaders. On the Cloudflare Worker it authenticates
 * to Algod with the privileged, server-only `ALGOD_TOKEN` secret and may target a
 * runtime-configured node via the `ALGOD_SERVER` var (the per-Worker mainnet/
 * testnet `vars` in wrangler.jsonc, or `.dev.vars` locally); the public
 * VITE_ALGOD_* values that ship in the browser are never used for these reads.
 *
 * Why this is leak-proof: the values come from `createIsomorphicFn().server()`,
 * whose body — and its `cloudflare:workers` import — is stripped from the client
 * bundle by the TanStack Start compiler (verified by grepping dist/client).
 * Route loaders re-run in the browser on client-side navigation; there the
 * `.client()` impl returns no overrides and the reader falls back to the public
 * Vite config, exactly like the in-browser GGovSDKProvider.
 */
const getWorkerAlgodOverrides = createIsomorphicFn()
  .client(async (): Promise<AlgodOverrides> => ({}))
  .server(async (): Promise<AlgodOverrides> => {
    const { env } = await import('cloudflare:workers')
    return {
      server: env.ALGOD_SERVER || undefined,
      token: env.ALGOD_TOKEN || undefined,
    }
  })

export async function createServerReaderSDK() {
  return createReaderSDK(await getWorkerAlgodOverrides())
}
