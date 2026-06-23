import { createFileRoute } from '@tanstack/react-router'
import DocsFaq from '@/components/pages/docs/Faq'

export const Route = createFileRoute('/docs/faq')({
  component: DocsFaq,
})
