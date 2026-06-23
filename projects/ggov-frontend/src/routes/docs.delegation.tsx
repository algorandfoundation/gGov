import { createFileRoute } from '@tanstack/react-router'
import DocsDelegation from '@/components/pages/docs/Delegation'

export const Route = createFileRoute('/docs/delegation')({
  component: DocsDelegation,
})
