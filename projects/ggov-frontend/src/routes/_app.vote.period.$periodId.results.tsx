import { createFileRoute } from '@tanstack/react-router'
import VotePeriodResults from '@/components/pages/vote/VotePeriodResults'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchPeriod, fetchPeriodBody, fetchTopicBodies, queryKeys } from '@/hooks/queries'

// Mirrors the period-detail route: SSR the period title/topic titles by seeding
// the same query keys the results page reads. Voter/committee/vote-record reads
// stay client-side (the last needs the connected wallet anyway).
export const Route = createFileRoute('/_app/vote/period/$periodId/results')({
  loader: async ({ context, params }) => {
    const periodId = Number(params.periodId)
    if (!Number.isFinite(periodId)) return
    const reader = await createServerReaderSDK()
    try {
      const period = await context.queryClient.ensureQueryData({
        queryKey: queryKeys.period(periodId),
        queryFn: () => fetchPeriod(reader, periodId),
      })
      await Promise.all([
        context.queryClient.ensureQueryData({
          queryKey: queryKeys.periodBody(periodId),
          queryFn: () => fetchPeriodBody(reader, periodId),
        }),
        period.topics.length > 0
          ? context.queryClient.ensureQueryData({
              queryKey: queryKeys.topicBodies(periodId),
              queryFn: () => fetchTopicBodies(reader, periodId, period.topics.length),
            })
          : Promise.resolve(),
      ])
    } catch (err) {
      // Best-effort SSR: on a reader failure, fall back to the page's hooks
      // fetching client-side rather than failing the whole route.
      console.error(`period ${periodId} results loader failed:`, err)
    }
  },
  component: VotePeriodResults,
})
