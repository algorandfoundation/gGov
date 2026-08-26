import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { type FracPipelinePlugin, type FracPipelinePluginConstructor } from './base.ts'
import { RetiPipelinePlugin } from './reti/index.ts'
import { TalgoPipelinePlugin } from './talgo/index.ts'
import { XalgoPipelinePlugin } from './xalgo/index.ts'

export * from './base.ts'
export * from './reti/index.ts'
export * from './talgo/index.ts'
export * from './xalgo/index.ts'

/**
 * Every plugin the pipeline can load. Adding a source is adding its class here — nothing else in the
 * pipeline needs to know about it.
 */
const PLUGIN_CLASSES_ARR: FracPipelinePluginConstructor[] = [
  RetiPipelinePlugin,
  TalgoPipelinePlugin,
  XalgoPipelinePlugin,
]

/** source name > plugin class */
export const PLUGIN_CLASSES: Record<string, FracPipelinePluginConstructor> = Object.fromEntries(
  PLUGIN_CLASSES_ARR.map((Plugin) => [Plugin.source, Plugin]),
)

/** Source names the pipeline can currently run. */
export const AVAILABLE_SOURCES = Object.keys(PLUGIN_CLASSES)

/**
 * Instantiate the plugin for a staking source. Does not call `init()`: the caller decides when the
 * plugin gets to do its async setup.
 * @param source staking source name, e.g. `reti`
 * @param algorand client the plugin reads staking data with
 * @param overrides plugin-specific configuration, validated by the plugin itself
 * @param concurrency independent reads the plugin runs at once; defaults to `SCAN_CONCURRENCY`
 */
export function createUninitializedPlugin(
  source: string,
  algorand: AlgorandClient,
  overrides?: Record<string, unknown>,
  concurrency?: number,
): FracPipelinePlugin {
  const Plugin = PLUGIN_CLASSES[source]
  if (!Plugin) throw new Error(`Unknown staking source: ${source}`)
  return new Plugin(algorand, overrides, concurrency)
}

/**
 * Instantiate and initialize the plugin for a staking source.
 * @param source staking source name, e.g. `reti`
 * @param algorand client the plugin reads staking data with
 * @param overrides plugin-specific configuration, validated by the plugin itself
 * @param concurrency independent reads the plugin runs at once; defaults to `SCAN_CONCURRENCY`
 * @returns initialized plugin instance
 */
export async function getPlugin(
  source: string,
  algorand: AlgorandClient,
  overrides?: Record<string, unknown>,
  concurrency?: number,
): Promise<FracPipelinePlugin> {
  const plugin = createUninitializedPlugin(source, algorand, overrides, concurrency)
  await plugin.init()
  return plugin
}

// returns map of source name > initialized plugin instances
export async function getAllPlugins(
  algorand: AlgorandClient,
  overrides?: Record<string, unknown>,
  concurrency?: number,
): Promise<Record<string, FracPipelinePlugin>> {
  const plugins: Record<string, FracPipelinePlugin> = {}
  for (const source of AVAILABLE_SOURCES) {
    plugins[source] = await getPlugin(source, algorand, overrides, concurrency)
  }
  return plugins
}
