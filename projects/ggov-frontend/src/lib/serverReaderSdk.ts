import { createIsomorphicFn } from '@tanstack/react-start'
import { createReaderSDK } from './readerSdk'

/**
 * Reader SDK for the SSR route loaders. On the Cloudflare Worker it authenticates
 * to Algod with the privileged, server-only `ALGOD_TOKEN` secret; the public
 * VITE_ALGOD_TOKEN that ships in the browser is never used for these reads.
 *
 * Why this is leak-proof: the token comes from `createIsomorphicFn().server()`,
 * whose body — and its `cloudflare:workers` import — is stripped from the client
 * bundle by the TanStack Start compiler (verified by grepping dist/client).
 * Route loaders re-run in the browser on client-side navigation; there the
 * `.client()` impl returns no token and the reader falls back to the public Vite
 * config, exactly like the in-browser GGovSDKProvider.
 */
const getWorkerAlgodToken = createIsomorphicFn()
  .client(async (): Promise<string | undefined> => undefined)
  .server(async (): Promise<string | undefined> => {
    const { env } = await import('cloudflare:workers')
    return env.ALGOD_TOKEN || undefined
  })

export async function createServerReaderSDK() {
  return createReaderSDK(await getWorkerAlgodToken())
}
