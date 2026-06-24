import { useEffect, useMemo, useState } from 'react'
import type { Preview } from '@storybook/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from '../src/components/ui/sonner'
import { ErrorDialogProvider } from '../src/hooks/useErrorDialog'
import { MockWalletProvider, demoAccounts, type MockWalletConfig } from './mocks/use-wallet-react'
import { MockScenarioProvider } from './mocks/queries'
import { RouteParamsProvider } from './mocks/tanstack-react-router'
import { defaultScenarioFromGlobals, type MockScenario } from './mocks/scenarios'
import '../src/main.css'

/** Default wallet for stories that don't pin `parameters.wallet` — driven by the `auth` global. */
function walletFromAuth(auth: string): MockWalletConfig {
  return auth === 'disconnected' ? { connected: false } : { walletName: 'Lute', accounts: [demoAccounts[0]] }
}

const preview: Preview = {
  globalTypes: {
    // `theme` and `auth` are two-option globals: they render as click-to-toggle
    // buttons via `.storybook/manager.tsx`, so they intentionally have NO `toolbar`
    // dropdown here — just the global definition + its default (in initialGlobals).
    theme: { description: 'Color theme (Algorand light/dark)' },
    auth: { description: 'Wallet connection state' },
    // `election` is also a two-option global → click-to-toggle button in manager.tsx.
    election: { description: 'Period type (standard vs election)' },
    // Reusable period-phase toggle: drives the default single-period scenario for
    // any story without a pinned `parameters.scenario` (multi-period pages pin one).
    periodPhase: {
      description: 'Default period phase',
      toolbar: {
        title: 'Phase',
        icon: 'calendar',
        items: [
          { value: 'upcoming', title: 'Upcoming' },
          { value: 'active', title: 'Active' },
          { value: 'ended', title: 'Ended (past)' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', auth: 'connected', periodPhase: 'active', election: 'standard' },
  parameters: {
    layout: 'fullscreen',
    // We paint our own themed surface, so Storybook's backgrounds addon is noise.
    backgrounds: { disable: true },
    controls: { expanded: true },
    // Sidebar order: Pages first, then Components, then the misc dialogs, then the
    // rest. Within-group order is left to the (numeric-prefixed) titles.
    options: {
      storySort: {
        order: ['PAGES', 'COMPONENTS', 'MISC_DIALOGS', '*'],
      },
    },
  },
  decorators: [
    (Story, context) => {
      // Fresh client per story so React Query cache (staleTime: Infinity) doesn't
      // leak between stories and make them order-dependent.
      const [queryClient] = useState(
        () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
      )
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light'
      useEffect(() => {
        // Dark mode is class-based (`.dark` ancestor). Radix dialogs/menus portal
        // to <body>, so the class must live on <html> for portaled overlays to
        // inherit the dark design tokens too.
        const root = document.documentElement
        root.classList.toggle('dark', theme === 'dark')
        return () => root.classList.remove('dark')
      }, [theme])

      const auth = context.globals.auth === 'disconnected' ? 'disconnected' : 'connected'
      const phase = context.globals.periodPhase ?? 'active'
      const election = context.globals.election === 'election'
      const pinnedWallet = context.parameters.wallet as MockWalletConfig | undefined
      const wallet = pinnedWallet ?? walletFromAuth(auth)
      // Remount the wallet provider when the auth global flips so its internal
      // connected/active-account state resets cleanly.
      const walletKey = pinnedWallet ? 'pinned' : auth

      // A story pins `parameters.scenario`; otherwise the toolbar globals drive a
      // default single-period scenario. Memoised so result objects stay referentially
      // stable across renders (the page effects depend on some of them).
      const scenario = useMemo(
        () =>
          (context.parameters.scenario as MockScenario | undefined) ??
          defaultScenarioFromGlobals(auth, phase, election),
        [context.parameters.scenario, auth, phase, election],
      )
      const routeParams = (context.parameters.routeParams ?? {}) as Record<string, string>

      return (
        <QueryClientProvider client={queryClient}>
          <MockWalletProvider key={walletKey} config={wallet}>
            <MockScenarioProvider scenario={scenario}>
              <RouteParamsProvider params={routeParams}>
                <ErrorDialogProvider>
                  <div className="bg-background text-foreground font-sans flex min-h-screen w-full items-start justify-center p-8">
                    <Story />
                  </div>
                </ErrorDialogProvider>
              </RouteParamsProvider>
            </MockScenarioProvider>
            {/* Mounted as in AppProviders; theme prop keeps toasts in sync with the toolbar. */}
            <Toaster position="bottom-right" theme={theme} />
          </MockWalletProvider>
        </QueryClientProvider>
      )
    },
  ],
}

export default preview
