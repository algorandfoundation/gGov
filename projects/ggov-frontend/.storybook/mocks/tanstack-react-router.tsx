import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react"

/**
 * Storybook mock for `@tanstack/react-router`. Aliased in `.storybook/main.ts` so
 * leaf UI components render without a real router context: `Link` becomes a plain
 * anchor (ignoring `to`/`params`/`search`), and the common hooks return inert stubs.
 */
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

export function useParams() {
  return {} as Record<string, string>
}

export function useLocation() {
  return { pathname: "/", search: "", hash: "" }
}

export function useRouter() {
  return {}
}

export function Outlet() {
  return null
}
