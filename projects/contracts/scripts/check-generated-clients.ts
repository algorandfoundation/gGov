/**
 * Assert that the generated ARC-56 clients copied into the SDK packages are byte-for-byte identical
 * to the freshly generated clients in the contracts `artifacts/` tree.
 *
 * The SDKs vendor these clients via their `prebuild` step (`cp ../contracts/.../XClient.ts src/generated/`).
 * If the contracts are rebuilt without rebuilding the SDKs, the SDK calls a stale ABI
 * and the contracts test suite silently runs against the wrong client. This check fails fast instead.
 *
 * Reused by the vitest globalSetup and runnable manually:  pnpm --filter smart_contracts check-clients
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const contractsRoot = resolve(here, '..') // projects/contracts
const projectsRoot = resolve(here, '../..') // projects

interface ClientPair {
  name: string
  /** Source of truth: generated into the contracts artifacts tree. */
  contract: string
  /** Vendored copy inside an SDK package. */
  sdk: string
}

const CLIENT_PAIRS: ClientPair[] = [
  {
    name: 'GGovRegistryClient',
    contract: resolve(contractsRoot, 'smart_contracts/artifacts/ggov-registry/GGovRegistryClient.ts'),
    sdk: resolve(projectsRoot, 'ggov-sdk/src/generated/GGovRegistryClient.ts'),
  },
  {
    name: 'GGovPeriodClient',
    contract: resolve(contractsRoot, 'smart_contracts/artifacts/ggov-period/GGovPeriodClient.ts'),
    sdk: resolve(projectsRoot, 'ggov-sdk/src/generated/GGovPeriodClient.ts'),
  },
  // {
  //   name: 'DelegatorClient',
  //   contract: resolve(contractsRoot, 'smart_contracts/artifacts/delegator/DelegatorClient.ts'),
  //   sdk: resolve(projectsRoot, 'delegator-sdk/src/generated/DelegatorClient.ts'),
  // },
]

const REBUILD_HINT = [
  'Rebuild the contracts and SDKs so the generated clients match:',
  '  pnpm --filter smart_contracts build',
  '  pnpm --filter ggov-sdk build',
].join('\n')

export class GeneratedClientsOutOfSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeneratedClientsOutOfSyncError'
  }
}

const rel = (p: string) => relative(projectsRoot, p)

/** Throws {@link GeneratedClientsOutOfSyncError} if any SDK client copy differs from its contract artifact. */
export function assertGeneratedClientsInSync(): void {
  const problems: string[] = []

  for (const pair of CLIENT_PAIRS) {
    if (!existsSync(pair.contract)) {
      problems.push(`  - ${pair.name}: missing contract artifact (${rel(pair.contract)}) — contracts not built`)
      continue
    }
    if (!existsSync(pair.sdk)) {
      problems.push(`  - ${pair.name}: missing SDK copy (${rel(pair.sdk)}) — SDK not built`)
      continue
    }
    if (!readFileSync(pair.contract).equals(readFileSync(pair.sdk))) {
      problems.push(`  - ${pair.name}: ${rel(pair.sdk)} differs from ${rel(pair.contract)}`)
    }
  }

  if (problems.length > 0) {
    throw new GeneratedClientsOutOfSyncError(
      `Generated clients are out of sync between contracts and SDKs:\n${problems.join('\n')}\n\n${REBUILD_HINT}`,
    )
  }
}

// CLI entry: `tsx scripts/check-generated-clients.ts`
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  try {
    assertGeneratedClientsInSync()
    console.log('Generated clients are in sync.')
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
