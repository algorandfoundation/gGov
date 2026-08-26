import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { FracDelegationRegistrySDK } from 'frac-delegation-sdk'
import { GGovRegistrySDK } from 'ggov-sdk'
import type { Address, TransactionSigner } from 'algosdk'
import { appIdFromEnv } from './deploy-utils'

type WriterAccount = { sender: Address; signer: TransactionSigner }

/** The slice of both registry SDKs that wiring needs. */
type RegistrySDK = {
  appId: bigint
  getAdmin: () => Promise<string>
  getGlobalState: () => Promise<Record<string, unknown>>
}

/** App ids deployed by the current run, keyed by contract directory name. */
export type DeployedAppIds = Map<string, bigint>

/**
 * Read an app id from `envVar`, confirming it exists on chain: a stale id (e.g. surviving a
 * localnet reset) would otherwise be written into a registry's global state as a dead link.
 */
async function appIdFromEnvIfExists(algorand: AlgorandClient, envVar: string, appName: string) {
  const appId = appIdFromEnv(envVar)
  if (appId === undefined) return undefined
  try {
    await algorand.app.getById(appId)
  } catch {
    console.warn(`${appName}: app ${appId} from ${envVar} does not exist, ignoring.`)
    return undefined
  }
  console.log(`${appName}: using app id ${appId} from ${envVar}`)
  return appId
}

/**
 * Resolve an app id: deployed by this run, else the `envVar` override, else the app of that name
 * created by `creator`. Lets a standalone deploy (`deploy:ci frac-delegation`) wire against apps that
 * already exist, using the same code path as a full-bundle deploy.
 */
async function resolveAppId(
  algorand: AlgorandClient,
  creator: Address,
  deployed: DeployedAppIds,
  { dirName, envVar, appName }: { dirName: string; envVar: string; appName: string },
): Promise<bigint | undefined> {
  const fromRun = deployed.get(dirName)
  if (fromRun !== undefined) return fromRun

  const override = await appIdFromEnvIfExists(algorand, envVar, appName)
  if (override !== undefined) return override

  const lookup = await algorand.appDeployer.getCreatorAppsByName(creator)
  const existing = lookup.apps[appName]
  if (existing) {
    console.log(`${appName}: using app id ${existing.appId} deployed by ${creator}`)
    return existing.appId
  }
  return undefined
}

/** Point `sdk`'s `key` global at `value`, skipping the call when it already holds that value. */
async function link(
  sdk: RegistrySDK,
  deployer: Address,
  { name, key, value, set }: { name: string; key: string; value: bigint; set: () => Promise<unknown> },
) {
  const label = `${name}.${key}`
  const state = await sdk.getGlobalState()

  if (state[key] === value) {
    console.log(`${label}: already set to ${value}`)
    return
  }

  // Only once a write is actually needed: every setter is admin-only, and the target may be an app
  // this DEPLOYER is not admin of, where a rejected call surfaces as an opaque logic-eval error.
  const admin = await sdk.getAdmin()
  if (admin !== deployer.toString()) {
    console.warn(`${label}: app ${sdk.appId} is administered by ${admin}, not ${deployer} — skipping.`)
    return
  }

  await set()
  console.log(`${label}: set to ${value}`)
}

/**
 * Wire every cross-app link between the registries, after all deploy configs have run.
 *
 * Kept out of the per-contract deploy configs on purpose: each link needs both app ids, so a
 * config can only ever see half of it (ggov-registry deploys before frac-delegation), and the
 * resolution rules would otherwise be duplicated and drift between the two files.
 *
 * Links: GGovRegistry.xGovRegistryApp, GGovRegistry.fracRegistryApp (read by
 * `importFracDelegations`), and FracDelegationRegistry.gGovRegistryApp.
 */
export async function wireRegistries(algorand: AlgorandClient, deployer: WriterAccount, deployed: DeployedAppIds) {
  console.log('\n=== Wiring registries ===')
  const creator = deployer.sender

  const gGovId = await resolveAppId(algorand, creator, deployed, {
    dirName: 'ggov-registry',
    envVar: 'GGOV_REGISTRY_APP_ID',
    appName: 'GGovRegistry',
  })
  const fracId = await resolveAppId(algorand, creator, deployed, {
    dirName: 'frac-delegation',
    envVar: 'FRAC_REGISTRY_APP_ID',
    appName: 'FracDelegationRegistry',
  })
  // Never deployed by this repo (the mock is disabled), so env-only.
  const xGovId = await appIdFromEnvIfExists(algorand, 'XGOV_REGISTRY_APP_ID', 'xGovRegistry')

  const missing = [
    gGovId === undefined ? 'GGovRegistry' : undefined,
    fracId === undefined ? 'FracDelegationRegistry' : undefined,
  ].filter((name) => name !== undefined)
  if (missing.length > 0) {
    console.warn(
      `No ${missing.join(' and no ')} found: the gGov <-> frac-delegation link is left unconfigured. ` +
        `Deploy with the same DEPLOYER, or set the app id env vars and re-run the deploy.`,
    )
  }

  if (gGovId !== undefined) {
    const gGov = new GGovRegistrySDK({ algorand, registryAppId: gGovId, writerAccount: deployer })

    if (xGovId === undefined) {
      // The only link with no fallback resolution, so an unset env var is easy to miss.
      console.warn(
        'GGovRegistry.xGovRegistryApp is left unconfigured: set XGOV_REGISTRY_APP_ID and re-run the ' +
          'deploy, or call setXGovRegistryApp directly.',
      )
    } else {
      await link(gGov, creator, {
        name: 'GGovRegistry',
        key: 'xGovRegistryApp',
        value: xGovId,
        set: () => gGov.setXGovRegistryApp({ appId: xGovId }),
      })
    }
    if (fracId !== undefined) {
      await link(gGov, creator, {
        name: 'GGovRegistry',
        key: 'fracRegistryApp',
        value: fracId,
        set: () => gGov.setFracRegistryApp({ appId: fracId }),
      })
    }
  }

  if (fracId !== undefined && gGovId !== undefined) {
    const frac = new FracDelegationRegistrySDK({ algorand, registryAppId: fracId, writerAccount: deployer })
    await link(frac, creator, {
      name: 'FracDelegationRegistry',
      key: 'gGovRegistryApp',
      value: gGovId,
      set: () => frac.setGGovRegistryApp({ appId: gGovId }),
    })
  }
}
