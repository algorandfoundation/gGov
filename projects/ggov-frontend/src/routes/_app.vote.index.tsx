import { createFileRoute } from '@tanstack/react-router'
import VotePeriods from '@/components/pages/vote/VotePeriods'

export const Route = createFileRoute('/_app/vote/')({
  ssr: false,
  component: VotePeriods,
})
