import { createFileRoute } from '@tanstack/react-router'
import VotePeriodDetail from '@/components/pages/vote/VotePeriodDetail'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchPeriod, fetchPeriodBody, fetchTopicBodies, queryKeys } from '@/hooks/queries'

// SSR the period title/description and each topic's title/description by seeding
// the query cache server-side with the same keys the page's hooks read. The
// wallet/voting UI stays behind `activeAddress &&` so it only renders after
// client hydration.
export const Route = createFileRoute('/_app/vote/period/$periodId')({
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
      console.error(`period ${periodId} loader failed:`, err)
    }
  },
  component: VotePeriodDetail,
})
