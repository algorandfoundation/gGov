import { createFileRoute } from '@tanstack/react-router'
import DocsGettingStarted from '@/components/pages/docs/GettingStarted'

export const Route = createFileRoute('/docs/getting-started')({
  component: DocsGettingStarted,
})
