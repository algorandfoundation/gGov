import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

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
      // Resolve workspace SDKs to source for proper bundling
      'ggov-sdk': path.resolve(__dirname, '../ggov-sdk/src/index.ts'),
      'ggov-registry-sdk': path.resolve(__dirname, '../ggov-registry-sdk/src/index.ts'),
    },
  },
  // Ensure vite-plugin-node-polyfills shims can be resolved from linked packages
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // Suppress the unresolved import warning for polyfill shims (they're injected at runtime)
        if (warning.message?.includes('vite-plugin-node-polyfills/shims')) return
        defaultHandler(warning)
      },
    },
  },
})
