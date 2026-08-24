import { createFileRoute, notFound } from '@tanstack/react-router'
import PoolDetail from '@/components/pages/vote/PoolDetail'
import { createServerReaderSDK } from '@/lib/serverReaderSdk'
import { fetchCommittee, fetchCommittees, fetchPeriods, fromBase64Url, queryKeys } from '@/hooks/queries'

/**
 * One pool's standing in one committee. SSRs exactly what the pools index does —
 * the committee, the committee list behind the period picker, and the periods
 * that ran on each window — because every figure above the voting record is
 * committee-scoped. The pool itself, its members and its tally are read
 * client-side from the frac registry, which is lazily imported.
 *
 * `?period=` picks the ballot the voting record is scoped to; it is validated
 * against the committee's own periods in the component (the loader has no
 * committee-to-period mapping cheaper than the page's), so an unusable value
 * falls back to the newest rather than 404ing a page that is otherwise fine.
 */
export const Route = createFileRoute('/_app/pools/$committeeId/$instanceNumId')({
  validateSearch: (search: Record<string, unknown>): { period?: number } => {
    const raw = search.period
    const period = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isInteger(period) && period >= 0 ? { period } : {}
  },
  loader: async ({ context, params }) => {
    const idB64 = params.committeeId

    // A pool is addressed by its frac instance's numeric id — which the registry
    // types `uint16`, so anything outside 1..65535 can never resolve to one. The
    // upper bound matters as much as the lower: without it an oversized id reaches
    // the SDK and throws out of `assertUint(…, 16)` instead of 404ing. Same
    // up-front rejection the committee id gets below: a 404, not a transient
    // reader failure.
    const instanceNumId = Number(params.instanceNumId)
    if (!Number.isInteger(instanceNumId) || instanceNumId <= 0 || instanceNumId > 65535) throw notFound()

    // A committee id is 32 bytes of base64url; anything that fails to decode or
    // has the wrong length can never name one.
    let idBytes: Uint8Array | undefined
    try {
      idBytes = fromBase64Url(idB64)
    } catch {
      idBytes = undefined
    }
    if (!idBytes || idBytes.length !== 32) throw notFound()

    const reader = await createServerReaderSDK()

    // The picker and the "Period N" labels are chrome: a failure there leaves the
    // page usable, so they stay best-effort and refetch client-side.
    const chrome = Promise.all([
      context.queryClient.ensureQueryData({ queryKey: queryKeys.committees, queryFn: () => fetchCommittees(reader) }),
      context.queryClient.ensureQueryData({ queryKey: queryKeys.periods, queryFn: () => fetchPeriods(reader) }),
    ]).catch((err) => {
      console.error(`pool ${instanceNumId} chrome loader failed:`, err)
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
      console.error(`pool ${instanceNumId} loader failed:`, err)
      await chrome
      return
    }
    // The committee is the denominator for every share on this page, so an id
    // that isn't in the registry is a genuine 404 rather than an empty page.
    if (!committee) throw notFound()
    await chrome
  },
  component: PoolDetail,
})
