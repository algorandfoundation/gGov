import type { FracDelegationReaderSDK } from 'frac-delegation-sdk'
import { createAlgorandClient } from './readerSdk'

/**
 * Reader-side construction for the fractional-delegation (pooled voting) registry.
 *
 * Split out from `readerSdk.ts` for two reasons. First, the frac deployment is
 * optional: `VITE_FRAC_REGISTRY_APP_ID` is unset on networks that have no frac
 * registry, and the whole pooled feature then goes dark (same shape as
 * `escregAppId` in `readerSdk.ts`). Second, the two generated frac clients carry
 * large inline ARC-56 app specs, so the SDK is loaded through a dynamic
 * `import()` and lands in its own chunk rather than the main bundle — a visitor
 * who isn't in any pool never downloads it.
 */

/** Frac registry app ID, or undefined on networks with no frac deployment. */
export const fracRegistryAppId = import.meta.env.VITE_FRAC_REGISTRY_APP_ID
  ? BigInt(import.meta.env.VITE_FRAC_REGISTRY_APP_ID)
  : undefined

/**
 * Whether this network has pooled voting at all. Cheap to read (no import), so
 * it's what every pooled query gates on — see `hooks/fracQueries.ts`.
 */
export const fracEnabled = fracRegistryAppId !== undefined

let cached: Promise<FracDelegationReaderSDK> | null = null

/**
 * Lazily construct the combined frac reader (it exposes `.registry` for the
 * cross-instance readers). Returns null when the network has no frac registry,
 * so callers never import the SDK on those networks.
 */
export function getFracReaderSDK(): Promise<FracDelegationReaderSDK> | null {
  if (fracRegistryAppId === undefined) return null
  cached ??= import('frac-delegation-sdk').then(
    ({ FracDelegationReaderSDK }) =>
      new FracDelegationReaderSDK({
        algorand: createAlgorandClient(),
        registryAppId: fracRegistryAppId,
        concurrency: 8,
      }),
  )
  return cached
}
