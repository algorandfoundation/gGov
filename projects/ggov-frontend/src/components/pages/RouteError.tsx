import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import StatusScreen from '@/components/StatusScreen'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Router-wide `defaultErrorComponent`: the branded in-shell error screen for a
 * loader/render failure in any route. TanStack catches such errors at the
 * route's own boundary (they never reach the root `errorComponent`), rendering
 * this in place of the route's content — so for `/_app/*` routes it appears
 * inside the sidebar layout. `reset` retries the failed render/loader. Shorter
 * than full-height since it sits within the app chrome.
 */
export default function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <StatusScreen
      className="min-h-[60vh]"
      title="Something went wrong"
      description="This page failed to load. You can try again, copy the details, or head back home."
      message={error?.message}
      actions={
        <>
          <Button onClick={reset}>Try again</Button>
          <Link to="/" className={cn(buttonVariants({ variant: 'outline' }))}>
            Go home
          </Link>
        </>
      }
    />
  )
}
