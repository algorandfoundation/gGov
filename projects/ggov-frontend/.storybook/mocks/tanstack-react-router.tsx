import { createContext, forwardRef, useContext, type AnchorHTMLAttributes, type ReactNode } from 'react'

/**
 * Storybook mock for `@tanstack/react-router`. Aliased in `.storybook/main.ts` so
 * leaf UI components render without a real router context: `Link` becomes a plain
 * anchor (ignoring `to`/`params`/`search`), and the common hooks return inert stubs.
 *
 * `useParams()` reads from `RouteParamsContext` so route-driven pages (e.g. the
 * vote detail page, which reads `periodId`) get the params a story supplies via
 * `parameters.routeParams`. The provider lives here so the aliased `useParams`
 * import and `preview.tsx`'s provider share one context instance.
 */
const RouteParamsContext = createContext<Record<string, string>>({})

export function RouteParamsProvider({ params, children }: { params: Record<string, string>; children: ReactNode }) {
  return <RouteParamsContext.Provider value={params}>{children}</RouteParamsContext.Provider>
}
export const Link = forwardRef<
  HTMLAnchorElement,
  {
    to?: string
    params?: Record<string, unknown>
    search?: Record<string, unknown>
    children?: ReactNode
  } & AnchorHTMLAttributes<HTMLAnchorElement>
>(function Link({ to, params, search, children, ...props }, ref) {
  return (
    <a ref={ref} href="#" {...props}>
      {children}
    </a>
  )
})

export function useNavigate() {
  return () => {}
}

export function useParams(_opts?: { strict?: boolean; from?: string }) {
  return useContext(RouteParamsContext)
}

export function useLocation() {
  return { pathname: '/', search: '', hash: '' }
}

export function useRouter() {
  return {}
}

export function Outlet() {
  return null
}
