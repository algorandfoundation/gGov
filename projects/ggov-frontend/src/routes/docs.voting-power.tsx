import { createFileRoute } from '@tanstack/react-router'
import DocsVotingPower from '@/components/pages/docs/VotingPower'

export const Route = createFileRoute('/docs/voting-power')({
  component: DocsVotingPower,
})
