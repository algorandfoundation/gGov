import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'
import { confirmPhase, resetPhase } from '@/lib/transactionPhase'
import { emitSurfacedError } from '@/lib/errorBus'
import RouteError from '@/components/pages/RouteError'

// Per-request on the server, once on the client. The custom caches drive the
// global transaction phase from every mutation's lifecycle so buttons can flash
// signing → sending → confirmed without each mutation opting in. Mutations that
// don't submit a transaction can set `meta: { skipTransactionPhase: true }`.
function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        console.error(`Query failed [${JSON.stringify(query.queryKey)}]:`, error)
        // Page-defining reads opt in with `meta: { surfaceError: true }` so a
        // failed primary load raises the error dialog instead of silently
        // looking like empty data. Optional/background reads stay untagged.
        // On the server there are no subscribers, so this is a no-op.
        if (query.meta?.surfaceError) emitSurfacedError(error)
      },
    }),
    mutationCache: new MutationCache({
      onMutate: (_vars, mutation) => {
        if (!mutation.meta?.skipTransactionPhase) resetPhase() // clear any stale 'confirmed' from a prior run
      },
      onError: (_err, _vars, _ctx, mutation) => {
        if (!mutation.meta?.skipTransactionPhase) resetPhase()
      },
      onSuccess: (_data, _vars, _ctx, mutation) => {
        if (!mutation.meta?.skipTransactionPhase) confirmPhase() // 'confirmed' flash, then auto-resets to idle
      },
    }),
  })
}

export function getRouter() {
  const queryClient = createQueryClient()

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // React Query owns caching of loader-seeded data, so don't let the router
    // hold its own stale copy of it.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Branded in-shell error screen for any route's loader/render failure. These
    // are caught at the route's own boundary and never reach the root
    // `errorComponent` (that one is the bare-document fallback for root/provider
    // failures), so without this they'd fall back to the router's plain default.
    defaultErrorComponent: RouteError,
  })

  // Wires QueryClient dehydrate/hydrate into the router (and provides
  // QueryClientProvider around the whole tree via router.options.Wrap).
  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
