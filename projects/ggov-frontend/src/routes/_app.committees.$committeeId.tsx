import { createFileRoute, notFound } from '@tanstack/react-router'
import CommitteeDetail from '@/components/pages/vote/CommitteeDetail'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { getErrorMessage } from '@/lib/errors'
import { fetchCommittee, fetchCommitteeMembers, queryKeys } from '@/hooks/queries'

// SSR the committee metadata + member list. Fully wallet-independent; per-account
// voting power (if any) hydrates client-side.
export const Route = createFileRoute('/_app/committees/$committeeId')({
  loader: async ({ context, params }) => {
    const idB64 = params.committeeId
    const reader = await createServerReaderSDK()

    // Fetch metadata + members together (as before). The metadata also decides
    // existence: a committee that isn't in the registry resolves to null and is a
    // genuine 404. A reader failure stays best-effort so the page's hooks can
    // refetch client-side (the committee query is surfaced to the error dialog).
    const committeePromise = context.queryClient.ensureQueryData({
      queryKey: queryKeys.committee(idB64),
      queryFn: () => fetchCommittee(reader, idB64),
    })
    const membersPromise = context.queryClient
      .ensureQueryData({
        queryKey: queryKeys.committeeMembers(idB64),
        queryFn: () => fetchCommitteeMembers(reader, idB64),
      })
      .catch((err) => {
        console.error(`committee ${idB64} members loader failed:`, err)
      })

    let committee
    try {
      committee = await committeePromise
    } catch (err) {
      // A malformed committee id (bad base64url / wrong length) can never resolve
      // to a committee — that's a 404, not a transient reader failure.
      if (/invalid committeeid/i.test(getErrorMessage(err))) throw notFound()
      console.error(`committee ${idB64} loader failed:`, err)
      return
    }
    if (!committee) throw notFound()
    await membersPromise
  },
  component: CommitteeDetail,
})
