/**
 * Vitest globalSetup — runs once before the whole test run (separate from per-file hooks).
 *
 *  1. Fail fast if the SDKs' vendored generated clients drift from the contracts artifacts.
 *  2. Ensure the LocalNet block clock is synced to wall-clock (auto-fix within 24h, else fail).
 *
 * Both checks are also runnable standalone:
 *   pnpm --filter smart_contracts check-clients
 *   pnpm --filter smart_contracts sync-clock
 */
import { assertGeneratedClientsInSync } from './scripts/check-generated-clients'
import { syncLocalNetClock } from './scripts/sync-localnet-clock'

export default async function setup() {
  assertGeneratedClientsInSync()

  const result = await syncLocalNetClock({ log: (m) => console.log(`[globalSetup] ${m}`) })
  if (result.blocksProduced > 0) {
    console.log(
      `[globalSetup] LocalNet clock synced: ${result.initialDriftSeconds}s -> ${result.finalDriftSeconds}s drift.`,
    )
  }
}
