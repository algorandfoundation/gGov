import { createFileRoute } from '@tanstack/react-router'
import DocsLayout from '@/components/DocsLayout'

// Public docs shell (its own chrome, independent of the app Layout). SSR is on
// (default) so the docs render server-side for fast first paint and indexing.
export const Route = createFileRoute('/docs')({
  component: DocsLayout,
})
