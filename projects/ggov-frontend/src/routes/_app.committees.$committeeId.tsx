import { createFileRoute } from '@tanstack/react-router'
import CommitteeDetail from '@/components/pages/vote/CommitteeDetail'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchCommittee, fetchCommitteeMembers, queryKeys } from '@/hooks/queries'

// SSR the committee metadata + member list. Fully wallet-independent; per-account
// voting power (if any) hydrates client-side.
export const Route = createFileRoute('/_app/committees/$committeeId')({
  loader: async ({ context, params }) => {
    const idB64 = params.committeeId
    const reader = await createServerReaderSDK()
    try {
      await Promise.all([
        context.queryClient.ensureQueryData({
          queryKey: queryKeys.committee(idB64),
          queryFn: () => fetchCommittee(reader, idB64),
        }),
        context.queryClient.ensureQueryData({
          queryKey: queryKeys.committeeMembers(idB64),
          queryFn: () => fetchCommitteeMembers(reader, idB64),
        }),
      ])
    } catch (err) {
      console.error(`committee ${idB64} loader failed:`, err)
    }
  },
  component: CommitteeDetail,
})
