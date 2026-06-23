import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(dirname, '../src')

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: { name: '@storybook/react-vite', options: {} },
  // Serve the app's self-hosted Aeonik/Inter fonts (referenced from /fonts/…).
  staticDirs: ['../public'],
  async viteFinal(config) {
    config.plugins = config.plugins ?? []
    // The app processes main.css through Tailwind v4's vite plugin.
    config.plugins.push(tailwindcss())
    // The project vite.config (react, tailwind, node-polyfills) is merged in by
    // the Storybook builder; dedupe by plugin name so the app's copies don't
    // collide with Storybook's own react/tailwind plugins.
    const seen = new Set<string>()
    config.plugins = (config.plugins as Array<{ name?: string }>)
      .flat()
      .filter((p) => {
        const name = p?.name
        if (!name) return true
        if (seen.has(name)) return false
        seen.add(name)
        return true
      })

    config.resolve = config.resolve ?? {}
    const existing = config.resolve.alias
    const existingArr = Array.isArray(existing)
      ? existing
      : Object.entries((existing as Record<string, string>) ?? {}).map(([find, replacement]) => ({
          find,
          replacement,
        }))
    // Mock wallet + mutations so dialogs render without a real wallet/SDK/network.
    // More-specific aliases first; keep the project's other aliases (ggov-sdk, shims).
    config.resolve.alias = [
      { find: '@/hooks/mutations', replacement: path.resolve(dirname, 'mocks/mutations.tsx') },
      { find: '@txnlab/use-wallet-react', replacement: path.resolve(dirname, 'mocks/use-wallet-react.tsx') },
      // The app migrated to @tanstack/react-router; mock it so leaf components render
      // without a router context (Link → anchor).
      { find: '@tanstack/react-router', replacement: path.resolve(dirname, 'mocks/tanstack-react-router.tsx') },
      { find: '@', replacement: src },
      ...existingArr.filter((a) => (a as { find?: string }).find !== '@'),
    ]
    return config
  },
}

export default config
