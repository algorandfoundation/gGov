import { createFileRoute, notFound } from '@tanstack/react-router'
import VotePeriodResults from '@/components/pages/vote/VotePeriodResults'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { getErrorMessage } from '@/lib/errors'
import { fetchPeriod, fetchPeriodBody, fetchTopicBodies, queryKeys } from '@/hooks/queries'

// Mirrors the period-detail route: SSR the period title/topic titles by seeding
// the same query keys the results page reads. Voter/committee/vote-record reads
// stay client-side (the last needs the connected wallet anyway).
export const Route = createFileRoute('/_app/vote/period/$periodId/results')({
  loader: async ({ context, params }) => {
    const periodId = Number(params.periodId)
    // Mirror the detail route: a non-integer / negative id (e.g. /1.5 or /abc)
    // can never name a real period — 404 instead of letting it reach the hooks,
    // whose unguarded BigInt() reads (useVoters, vote records) would otherwise
    // throw a raw RangeError client-side.
    if (!Number.isInteger(periodId) || periodId < 0) throw notFound()
    const reader = await createServerReaderSDK()

    // Existence gate (as in the detail route): getPeriod swallows misses, so
    // check the registry mapping directly — getPeriodAppId throws "… not found
    // in registry" for an unknown id. A genuine miss is a 404; any other reader
    // error stays best-effort (the page's hooks refetch client-side).
    try {
      await reader.getPeriodAppId(periodId)
    } catch (err) {
      if (/not found in registry/i.test(getErrorMessage(err))) throw notFound()
      console.error(`period ${periodId} results loader failed:`, err)
      return
    }

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
