import { createFileRoute, notFound } from '@tanstack/react-router'
import Pools from '@/components/pages/vote/Pools'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchCommittee, fetchCommittees, fetchPeriods, fromBase64Url, queryKeys } from '@/hooks/queries'

// SSR the committee metadata, the committee list (the selector) and the periods
// that used each window. All wallet-independent; the pool composition itself is
// read client-side from the frac registry, which is lazily imported.
export const Route = createFileRoute('/_app/pools/$committeeId')({
  loader: async ({ context, params }) => {
    const idB64 = params.committeeId

    // Same up-front validation as the committee page: a committee id is 32 bytes
    // of base64url, so anything that fails to decode or has the wrong length can
    // never resolve to one — that's a 404, not a transient reader failure.
    let idBytes: Uint8Array | undefined
    try {
      idBytes = fromBase64Url(idB64)
    } catch {
      idBytes = undefined
    }
    if (!idBytes || idBytes.length !== 32) throw notFound()

    const reader = await createServerReaderSDK()

    // The selector and the "Period N" labels are chrome: a failure there leaves
    // the page usable, so they stay best-effort and refetch client-side.
    const chrome = Promise.all([
      context.queryClient.ensureQueryData({ queryKey: queryKeys.committees, queryFn: () => fetchCommittees(reader) }),
      context.queryClient.ensureQueryData({ queryKey: queryKeys.periods, queryFn: () => fetchPeriods(reader) }),
    ]).catch((err) => {
      console.error(`pools ${idB64} chrome loader failed:`, err)
    })

    let committee
    try {
      committee = await context.queryClient.ensureQueryData({
        queryKey: queryKeys.committee(idB64),
        queryFn: () => fetchCommittee(reader, idB64),
      })
    } catch (err) {
      // The id is already validated, so this is a transient reader failure: stay
      // best-effort and let the page's hooks refetch client-side.
      console.error(`pools ${idB64} loader failed:`, err)
      await chrome
      return
    }
    // The committee is the denominator for every share on this page, so an id
    // that isn't in the registry is a genuine 404 rather than an empty page.
    if (!committee) throw notFound()
    await chrome
  },
  component: Pools,
})
