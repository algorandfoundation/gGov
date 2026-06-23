import { createFileRoute, notFound } from '@tanstack/react-router'
import VotePeriodDetail from '@/components/pages/vote/VotePeriodDetail'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { getErrorMessage } from '@/lib/errors'
import { fetchPeriod, fetchPeriodBody, fetchTopicBodies, queryKeys } from '@/hooks/queries'

// SSR the period title/description and each topic's title/description by seeding
// the query cache server-side with the same keys the page's hooks read. The
// wallet/voting UI stays behind `activeAddress &&` so it only renders after
// client hydration.
export const Route = createFileRoute('/_app/vote/period/$periodId')({
  loader: async ({ context, params }) => {
    const periodId = Number(params.periodId)
    // A non-integer / negative id (e.g. /vote/period/1.5 or /abc) can never name a
    // real period — a 404, matching the integer validation the page's hooks enforce.
    if (!Number.isInteger(periodId) || periodId < 0) throw notFound()
    const reader = await createServerReaderSDK()

    // Existence gate. getPeriod can't tell us a period is missing — it swallows
    // every failure and returns an empty sentinel — so check the registry mapping
    // directly: getPeriodAppId throws "… not found in registry" for an unknown id.
    // A genuine miss is a 404; any other reader error stays best-effort (the
    // page's hooks refetch client-side, and a hard failure raises the error
    // dialog, since the period query is surfaced).
    try {
      await reader.getPeriodAppId(periodId)
    } catch (err) {
      if (/not found in registry/i.test(getErrorMessage(err))) throw notFound()
      console.error(`period ${periodId} loader failed:`, err)
      return
    }

    // Best-effort SSR of the period + body/topic data by seeding the same query
    // keys the page's hooks read; on failure they fetch client-side rather than
    // failing the whole route.
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
      console.error(`period ${periodId} loader failed:`, err)
    }
  },
  component: VotePeriodDetail,
})
