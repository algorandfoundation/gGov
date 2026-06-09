import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
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

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: {
        Buffer: true,
      },
      // Override the shim resolution for linked workspace packages
      overrides: {
        buffer: 'buffer',
      },
    }),
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
