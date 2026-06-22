import { createFileRoute } from '@tanstack/react-router'
import DocsCommittees from '@/components/pages/docs/Committees'

export const Route = createFileRoute('/docs/committees')({
  component: DocsCommittees,
})
