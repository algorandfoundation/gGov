import { useEffect, useState } from 'react'
import type { Preview } from '@storybook/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from '../src/components/ui/sonner'
import { ErrorDialogProvider } from '../src/hooks/useErrorDialog'
import { MockWalletProvider, type MockWalletConfig } from './mocks/use-wallet-react'
import '../src/main.css'

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Color theme (Algorand light/dark)',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'fullscreen',
    // We paint our own themed surface, so Storybook's backgrounds addon is noise.
    backgrounds: { disable: true },
    controls: { expanded: true },
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

      const wallet = (context.parameters.wallet ?? {}) as MockWalletConfig

      return (
        <QueryClientProvider client={queryClient}>
          <MockWalletProvider config={wallet}>
            <ErrorDialogProvider>
              <div className="bg-background text-foreground font-sans flex min-h-screen w-full items-start justify-center p-8">
                <Story />
              </div>
            </ErrorDialogProvider>
            {/* Mounted as in AppProviders; theme prop keeps toasts in sync with the toolbar. */}
            <Toaster position="bottom-right" theme={theme} />
          </MockWalletProvider>
        </QueryClientProvider>
      )
    },
  ],
}

export default preview
