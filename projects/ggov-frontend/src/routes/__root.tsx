/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import AppProviders from '@/components/AppProviders'
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
  // Top-level catch-all (replaces the old main.tsx ErrorBoundary). Renders a bare
  // document without the app providers so a provider failure can't re-trigger it.
  errorComponent: ({ error }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="max-w-md text-center">
            <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
            <p className="text-muted-foreground">{error?.message}</p>
          </div>
        </div>
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
