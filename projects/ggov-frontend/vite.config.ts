import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { builtinModules } from 'module'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// vite-plugin-node-polyfills injects bare imports like
// `vite-plugin-node-polyfills/shims/buffer`. When a workspace package (ggov-sdk)
// is resolved to source, Rollup can't resolve these bare specifiers from the
// linked package's context and leaves them un-bundled, which throws at runtime
// in the browser ("bare specifier was not remapped"). Alias each shim to its
// resolved ESM file so Rollup bundles it.
const shimAliases = Object.fromEntries(
  ['buffer', 'process', 'global'].map((shim) => {
    const id = `vite-plugin-node-polyfills/shims/${shim}`
    return [id, require.resolve(id).replace(/\.cjs$/, '.js')]
  }),
)

// The browser (client) build needs the Buffer polyfill for algosdk. The Worker
// (SSR) environment has native Buffer/stream/process via `nodejs_compat`. Tag
// the node-polyfills plugins so their inject/resolve hooks only run for the
// client environment. (`nodePolyfills()` returns several plugins; normalise.)
const clientNodePolyfills = [
  nodePolyfills({
    globals: { Buffer: true },
    // Override the shim resolution for linked workspace packages
    overrides: { buffer: 'buffer' },
  }),
]
  .flat()
  .filter(Boolean)
  .map((plugin) => ({
    ...(plugin as Record<string, unknown>),
    applyToEnvironment: (env: { name: string }) => env.name === 'client',
  }))

// node-polyfills also sets a GLOBAL `resolve.alias` (via its `config` hook) that
// remaps node builtins to browserify shims — `applyToEnvironment` does not gate
// that. The Worker resolves builtins natively through `nodejs_compat`, so strip
// those aliases from every non-client environment (otherwise e.g. router-core's
// `node:stream/web` resolves to the non-existent `stream-browserify/web`).
const nodeBuiltinBases = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))
function isNodeBuiltinAliasKey(key: string): boolean {
  if (key.startsWith('node:')) return true
  return nodeBuiltinBases.has(key.split('/')[0])
}
const stripWorkerNodePolyfills = {
  name: 'strip-node-polyfills-from-worker',
  configEnvironment(name: string, config: { resolve?: { alias?: unknown } }) {
    if (name === 'client') return
    const alias = config.resolve?.alias
    if (!alias) return
    if (Array.isArray(alias)) {
      config.resolve!.alias = alias.filter((entry) => {
        const find = (entry as { find?: unknown })?.find
        return !(typeof find === 'string' && isNodeBuiltinAliasKey(find))
      })
    } else if (typeof alias === 'object') {
      for (const key of Object.keys(alias as Record<string, unknown>)) {
        if (isNodeBuiltinAliasKey(key)) delete (alias as Record<string, unknown>)[key]
      }
    }
  },
}

// Storybook loads this config too (its builder-vite merges it). The TanStack Start
// + Cloudflare Worker plugins inject the whole route tree / SSR worker, which
// Storybook neither needs nor can resolve against its mocks — so skip them (and the
// worker node-polyfill handling) when running under Storybook. The storybook scripts
// set STORYBOOK=true.
const isStorybook = !!process.env.STORYBOOK

export default defineConfig({
  plugins: isStorybook
    ? [react(), tailwindcss()]
    : [
        cloudflare({ viteEnvironment: { name: 'ssr' } }),
        tanstackStart(),
        react(),
        tailwindcss(),
        ...clientNodePolyfills,
        stripWorkerNodePolyfills,
      ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve workspace SDK to source for proper bundling
      'ggov-sdk': path.resolve(__dirname, '../ggov-sdk/src/index.ts'),
      // Resolve node-polyfills shim bare specifiers (see comment above)
      ...shimAliases,
    },
  },
})
