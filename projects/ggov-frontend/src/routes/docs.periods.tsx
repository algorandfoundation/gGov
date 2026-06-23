import { createFileRoute } from '@tanstack/react-router'
import DocsPeriods from '@/components/pages/docs/Periods'

export const Route = createFileRoute('/docs/periods')({
  component: DocsPeriods,
})
