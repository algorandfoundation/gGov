import { createFileRoute } from '@tanstack/react-router'
import DocsHome from '@/components/pages/docs/DocsHome'

export const Route = createFileRoute('/docs/')({
  component: DocsHome,
})
