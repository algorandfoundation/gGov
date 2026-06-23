/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import AppProviders from '@/components/AppProviders'
import NotFound from '@/components/pages/NotFound'
import StatusScreen from '@/components/StatusScreen'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
// Imported as a URL so the integration emits a <link rel="stylesheet"> during SSR
// (Tailwind v4 entry + self-hosted brand fonts live in this file).
import appCss from '../main.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'description', content: 'gGov — Algorand governance delegation and voting' },
      { name: 'theme-color', content: '#FFFFFF', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#001324', media: '(prefers-color-scheme: dark)' },
      { title: 'gGov' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'preload', href: '/fonts/Aeonik-Bold.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'preload', href: '/fonts/Inter-Regular.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
    ],
  }),
  component: RootComponent,
  // 404 boundary for unmatched URLs and `notFound()` thrown by child loaders.
  // Renders inside RootDocument, so it keeps the app chrome's providers/styling.
  notFoundComponent: () => <NotFound />,
  // Top-level catch-all (replaces the old main.tsx ErrorBoundary). Renders its own
  // bare document — without the app providers — so a provider failure can't
  // re-trigger it. Recoverable in-app errors surface through the error dialog
  // (useErrorDialog); this is the last resort, so it offers copy + reload + home.
  errorComponent: ({ error }) => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        <StatusScreen
          title="Something went wrong"
          description="An unexpected error occurred. You can copy the details below or reload the page."
          message={error?.message}
          actions={
            <>
              {/* window is only touched in the click handler, so SSR is safe. */}
              <button
                type="button"
                className={cn(buttonVariants())}
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
              <a href="/" className={cn(buttonVariants({ variant: 'outline' }))}>
                Go home
              </a>
            </>
          }
        />
        <Scripts />
      </body>
    </html>
  ),
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

// Applied before hydration so dark-mode users never see a flash of the light
// theme on the SSR'd routes (docs, vote/period, committees). Mirrors
// useTheme.getInitialTheme: dark is opt-in, so only a stored 'dark' adds the
// class — anything else (incl. storage being unavailable) stays light.
// `suppressHydrationWarning` on <html> covers the class this adds, which the
// server (no localStorage) can't have rendered.
const themeInitScript = `try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}`

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
        <Scripts />
      </body>
    </html>
  )
}
