import { createFileRoute, redirect } from '@tanstack/react-router'
import Pools from '@/components/pages/vote/Pools'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchCommittees, fetchPeriods, queryKeys } from '@/hooks/queries'

/**
 * `/pools` is a shortcut, not a page: pool composition is per committee, so this
 * resolves the current window and hands over to its own URL. Only when there is
 * no committee to redirect to does it render — the page then explains itself
 * instead of bouncing the visitor to a 404.
 */
export const Route = createFileRoute('/_app/pools/')({
  loader: async ({ context }) => {
    const reader = await createServerReaderSDK()

    // The period labels are chrome for the committee picker on the far side of
    // the redirect: best-effort, and awaited separately, so a failure there
    // cannot take the redirect down with it. The committee list is the only
    // read this route actually needs.
    const chrome = context.queryClient
      .ensureQueryData({ queryKey: queryKeys.periods, queryFn: () => fetchPeriods(reader) })
      .catch((err) => {
        console.error('pools index period preload failed:', err)
      })

    let committees
    try {
      committees = await context.queryClient.ensureQueryData({
        queryKey: queryKeys.committees,
        queryFn: () => fetchCommittees(reader),
      })
    } catch (err) {
      console.error('pools index loader failed:', err)
      return
    }
    await chrome

    // Committees come back newest-first, so the head is the live window.
    const current = committees[0]
    if (current) throw redirect({ to: '/pools/$committeeId', params: { committeeId: current.idBase64Url } })
  },
  component: Pools,
})
