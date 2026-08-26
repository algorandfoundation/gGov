import { createFileRoute } from '@tanstack/react-router'
import DocsPooledVoting from '@/components/pages/docs/PooledVoting'

export const Route = createFileRoute('/docs/pooled-voting')({
  component: DocsPooledVoting,
})
