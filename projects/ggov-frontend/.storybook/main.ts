import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(dirname, '../src')

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  // Storybook 9: the former addon-essentials (controls, actions, viewport,
  // backgrounds, toolbars, …) are built into core, so no addons entry is needed.
  framework: { name: '@storybook/react-vite', options: {} },
  // Serve the app's self-hosted Aeonik/Inter fonts (referenced from /fonts/…).
  staticDirs: ['../public'],
  async viteFinal(config) {
    config.plugins = config.plugins ?? []
    // The app processes main.css through Tailwind v4's vite plugin.
    config.plugins.push(tailwindcss())
    // The Storybook builder merges the project vite.config. The app's config drops
    // its TanStack Start / Cloudflare plugins when STORYBOOK=true (see vite.config),
    // so here we only dedupe by name — the app's react/tailwind copies otherwise
    // collide with Storybook's own.
    const seen = new Set<string>()
    config.plugins = (config.plugins as Array<{ name?: string }>).flat().filter((p) => {
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
      // Mock the data layer so the data-driven pages render from scenario fixtures
      // (see mocks/queries.tsx + mocks/scenarios.ts) without an SDK or network.
      { find: '@/hooks/queries', replacement: path.resolve(dirname, 'mocks/queries.tsx') },
      // The query hooks (and the detail page) read the SDK context; stub it so it
      // never throws or builds network clients. `sdk` tracks the mock wallet.
      { find: '@/hooks/useGGovSDK', replacement: path.resolve(dirname, 'mocks/useGGovSDK.tsx') },
      // Resolve NFD names from a static map instead of hitting the NFD API.
      { find: '@/hooks/use-nfd', replacement: path.resolve(dirname, 'mocks/use-nfd.tsx') },
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
