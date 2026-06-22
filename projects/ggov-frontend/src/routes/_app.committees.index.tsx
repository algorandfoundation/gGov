import { createFileRoute } from '@tanstack/react-router'
import Committees from '@/components/pages/vote/Committees'
import { createReaderSDK } from '@/lib/readerSdk'
import { fetchCommittees, fetchPeriods, queryKeys } from '@/hooks/queries'

// SSR the committee list (names, windows, member counts). Fully wallet-independent.
export const Route = createFileRoute('/_app/committees/')({
  loader: async ({ context }) => {
    const reader = createReaderSDK()
    try {
      await Promise.all([
        context.queryClient.ensureQueryData({
          queryKey: queryKeys.committees,
          queryFn: () => fetchCommittees(reader),
        }),
        // The page cross-references periods to show which committee each used.
        context.queryClient.ensureQueryData({
          queryKey: queryKeys.periods,
          queryFn: () => fetchPeriods(reader),
        }),
      ])
    } catch (err) {
      console.error('committees loader failed:', err)
    }
  },
  component: Committees,
})
