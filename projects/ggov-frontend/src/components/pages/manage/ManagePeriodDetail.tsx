import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { usePeriod, usePeriods, usePeriodBody, useTopicBodies, useCommittees, toBase64Url } from '@/hooks/queries'
import {
  useEditPeriodMutation,
  useUploadPeriodBodyMutation,
  useUploadTopicBodyMutation,
  useRemoveTopicMutation,
  useSetReadyMutation,
} from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import PeriodAppExplorerLink from '@/components/PeriodAppExplorerLink'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import { MarkdownContent } from '@/components/ui/markdown-content'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Callout } from '@/components/ui/callout'
import { EditOptionsDialog } from '@/components/pages/manage/EditOptionsDialog'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import BackButton from '@/components/BackButton'
import { formatTimestampUTC, toDatetimeLocalUTC, fromDatetimeLocalUTC, periodStatus } from '@/utils/time'
import { TxButton, TxButtonContent } from '@/components/TxButtonContent'

export default function ManagePeriodDetail() {
  const { periodId: pidParam } = useParams({ strict: false })
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()

  const { data: period, isLoading } = usePeriod(periodId)
  const { data: periodBody } = usePeriodBody(periodId)
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0)
  const { data: committees = [] } = useCommittees()
  const { data: allPeriods = [] } = usePeriods()
  const ready = allPeriods.find((p) => p.id === periodId)?.ready ?? false

  const editPeriodMutation = useEditPeriodMutation()
  const uploadPeriodBodyMutation = useUploadPeriodBodyMutation()
  const uploadTopicBodyMutation = useUploadTopicBodyMutation()
  const removeTopicMutation = useRemoveTopicMutation()
  const setReadyMutation = useSetReadyMutation()

  // Edit period form
  const [editCommittee, setEditCommittee] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')

  // Edit period body
  const [editPeriodTitle, setEditPeriodTitle] = useState('')
  const [editPeriodBody, setEditPeriodBody] = useState('')

  // Edit topic options dialog: tracks which topic is open; the dialog owns the form state.
  const [editingTopic, setEditingTopic] = useState<number | null>(null)

  // Edit topic body dialog
  const [editingTopicBody, setEditingTopicBody] = useState<number | null>(null)
  const [editTopicTitle, setEditTopicTitle] = useState('')
  const [editTopicBody, setEditTopicBody] = useState('')

  // Ready transition dialog
  const [readyDialogOpen, setReadyDialogOpen] = useState(false)

  // Remove-topic confirm dialog: tracks which topic index is pending confirmation.
  const [removingTopic, setRemovingTopic] = useState<number | null>(null)

  // Seed the edit forms once per period, keyed on periodId rather than the
  // query object identity — otherwise a background refetch (e.g. on window
  // refocus) overwrites the operator's in-progress edits.
  const seededEditPeriodId = useRef<number | null>(null)
  useEffect(() => {
    if (period && seededEditPeriodId.current !== periodId) {
      seededEditPeriodId.current = periodId
      setEditCommittee(toBase64Url(period.committeeId))
      setEditStart(toDatetimeLocalUTC(period.votingStart))
      setEditEnd(toDatetimeLocalUTC(period.votingEnd))
    }
  }, [period, periodId])

  const seededBodyPeriodId = useRef<number | null>(null)
  useEffect(() => {
    // `periodBody` is `undefined` while loading, then `null` or the body object.
    if (periodBody !== undefined && seededBodyPeriodId.current !== periodId) {
      seededBodyPeriodId.current = periodId
      setEditPeriodTitle(periodBody?.title ?? '')
      setEditPeriodBody(periodBody?.body ?? '')
    }
  }, [periodBody, periodId])

  function handleEditPeriod() {
    if (!editCommittee || !editStart || !editEnd) return
    const committee = committees.find((c) => c.idBase64Url === editCommittee)
    if (!committee) return
    editPeriodMutation.mutate({
      periodId,
      committeeId: committee.id,
      votingStart: BigInt(fromDatetimeLocalUTC(editStart)),
      votingEnd: BigInt(fromDatetimeLocalUTC(editEnd)),
    })
  }

  function handleSavePeriodBody() {
    if (!editPeriodTitle.trim() || !editPeriodBody.trim()) return
    uploadPeriodBodyMutation.mutate({
      periodId,
      body: { title: editPeriodTitle.trim(), body: editPeriodBody.trim() },
    })
  }

  function openEditTopicBody(topicIdx: number) {
    const tb = topicBodies[topicIdx]
    setEditingTopicBody(topicIdx)
    setEditTopicTitle(tb?.title ?? '')
    setEditTopicBody(tb?.body ?? '')
  }

  function handleSaveTopicBody() {
    if (editingTopicBody === null || !editTopicTitle.trim() || !editTopicBody.trim()) return
    uploadTopicBodyMutation.mutate(
      { periodId, topicIndex: editingTopicBody, body: { title: editTopicTitle.trim(), body: editTopicBody.trim() } },
      { onSuccess: () => setEditingTopicBody(null) },
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!period) {
    return <p className="text-muted-foreground">Period not found.</p>
  }

  const status = periodStatus(period.votingStart, period.votingEnd)
  const canEdit = status === 'upcoming' && !ready && !!sdk
  const hasVotes = period.topics.some(([, tallies]) => tallies.some((t) => t > 0))
  const readyWarnings: string[] = []
  if (!periodBody) readyWarnings.push('period body is missing')
  if (period.topics.length === 0) readyWarnings.push('no topics added')
  else if (topicBodies.length < period.topics.length || topicBodies.some((b) => !b))
    readyWarnings.push('one or more topics are missing a body')
  if (status === 'ended') readyWarnings.push('voting window has already ended')

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <BackButton to="/manage" />
        <h1 className="text-2xl font-bold">{periodBody?.title}</h1>
        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
        <span
          className={
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
            (ready
              ? 'bg-success/15 text-success-strong'
              : 'bg-warning/20 text-warning-strong')
          }
        >
          {ready ? 'Ready' : 'Draft'}
        </span>
        {sdk && (
          <Button
            size="sm"
            variant={ready ? 'outline' : 'default'}
            onClick={() => setReadyDialogOpen(true)}
            disabled={setReadyMutation.isPending || (ready && hasVotes)}
            aria-busy={setReadyMutation.isPending}
            title={ready && hasVotes ? 'Cannot revert to draft: votes have already been cast' : undefined}
          >
            <TxButtonContent
              pending={setReadyMutation.isPending}
              idleLabel={ready ? 'Revert to draft' : 'Mark ready'}
              pendingLabel="Saving…"
            />
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Committee:</span>{' '}
            {(() => {
              const key = toBase64Url(period.committeeId)
              const c = committees.find((c) => c.idBase64Url === key)
              return c ? `Rounds ${c.periodStart} — ${c.periodEnd}` : '—'
            })()}
          </div>

          {canEdit ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="edit-committee">Committee</Label>
                <select
                  id="edit-committee"
                  name="edit-committee"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={editCommittee}
                  onChange={(e) => setEditCommittee(e.target.value)}
                  required
                >
                  <option value="">Select a committee</option>
                  {committees.map((c) => (
                    <option key={c.idBase64Url} value={c.idBase64Url}>
                      Rounds {c.periodStart} — {c.periodEnd}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-voting-start">Voting start (UTC)</Label>
                  <Input
                    id="edit-voting-start"
                    name="edit-voting-start"
                    type="datetime-local"
                    value={editStart}
                    onChange={(e) => setEditStart(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-voting-end">Voting end (UTC)</Label>
                  <Input
                    id="edit-voting-end"
                    name="edit-voting-end"
                    type="datetime-local"
                    value={editEnd}
                    onChange={(e) => setEditEnd(e.target.value)}
                  />
                </div>
              </div>
              <TxButton
                size="sm"
                onClick={handleEditPeriod}
                pending={editPeriodMutation.isPending}
                success={editPeriodMutation.isSuccess}
                idleLabel="Save changes"
                pendingLabel="Saving…"
                confirmedLabel="Saved"
              />
            </div>
          ) : (
            <div className="text-sm">
              <span className="text-muted-foreground">Voting:</span>{' '}
              {formatTimestampUTC(period.votingStart)} — {formatTimestampUTC(period.votingEnd)}
            </div>
          )}

          <PeriodAppExplorerLink periodId={periodId} />
        </CardContent>
      </Card>

      {/* Period Body */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period body</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sdk ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-period-title">Title</Label>
                <Input
                  id="edit-period-title"
                  name="edit-period-title"
                  value={editPeriodTitle}
                  onChange={(e) => setEditPeriodTitle(e.target.value)}
                  placeholder="Period title"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-period-body">Description</Label>
                <MarkdownEditor
                  id="edit-period-body"
                  value={editPeriodBody}
                  onChange={setEditPeriodBody}
                  placeholder="Period description..."
                />
              </div>
              <TxButton
                size="sm"
                onClick={handleSavePeriodBody}
                pending={uploadPeriodBodyMutation.isPending}
                success={uploadPeriodBodyMutation.isSuccess}
                idleLabel={periodBody ? 'Update body' : 'Add body'}
                pendingLabel="Saving…"
                confirmedLabel="Saved"
              />
            </>
          ) : periodBody && (
            <div>
              <p className="font-medium">{periodBody.title}</p>
              <MarkdownContent className="mt-1">{periodBody.body}</MarkdownContent>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Topics ({period.topics.length})</h2>
        <Link to="/manage/period/$periodId/add-topic" params={{ periodId: String(periodId) }}>
          <Button variant="outline" size="sm">Add topic</Button>
        </Link>
      </div>

      {period.topics.length === 0 ? (
        <p className="text-muted-foreground">No topics yet. Add one to get started.</p>
      ) : (
        <div className="space-y-4">
          {period.topics.map(([options, tallies], topicIdx) => {
            const tb = topicBodies[topicIdx]
            // Hoisted out of the options.map below so it's summed once, not per option.
            const totalVotes = tallies.reduce((a, b) => a + b, 0)
            return (
              <Card key={topicIdx}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{tb?.title}</CardTitle>
                      {tb?.body && (
                        <CardDescription className="mt-1">
                          <MarkdownContent>{tb.body}</MarkdownContent>
                        </CardDescription>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {sdk && (
                        <Button variant="ghost" size="sm" onClick={() => openEditTopicBody(topicIdx)}>
                          {tb ? 'Edit body' : 'Add body'}
                        </Button>
                      )}
                      {canEdit && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditingTopic(topicIdx)}>
                            Edit options
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRemovingTopic(topicIdx)}
                            disabled={removeTopicMutation.isPending}
                            aria-busy={removeTopicMutation.isPending && removeTopicMutation.variables?.topicIndex === topicIdx}
                          >
                            <TxButtonContent
                              pending={removeTopicMutation.isPending && removeTopicMutation.variables?.topicIndex === topicIdx}
                              idleLabel="Remove"
                              pendingLabel="Removing…"
                            />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {options.map((option, optIdx) => {
                      const tally = tallies[optIdx] ?? 0
                      const pct = totalVotes > 0 ? (tally / totalVotes) * 100 : 0
                      return (
                        <div key={optIdx} className="flex items-center justify-between text-sm">
                          <span>{option}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {tally} votes{totalVotes > 0 ? ` (${pct.toFixed(1)}%)` : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Edit Topic Options Dialog */}
      {editingTopic !== null && (
        <EditOptionsDialog
          periodId={periodId}
          topicIndex={editingTopic}
          initialOptions={period.topics[editingTopic][0]}
          onClose={() => setEditingTopic(null)}
        />
      )}

      {/* Ready Transition Dialog */}
      <Dialog open={readyDialogOpen} onOpenChange={setReadyDialogOpen}>
        <DialogContent onClose={() => setReadyDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>
              {ready ? 'Revert period to Draft?' : 'Mark period as Ready?'}
            </DialogTitle>
          </DialogHeader>
          {ready ? (
            <div className="space-y-2 text-sm">
              <p>Reverting to Draft will:</p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>Hide this period from voters again</li>
                <li>Re-enable edits to the committee, voting window, topics, and options</li>
              </ul>
              <p className="text-muted-foreground">
                This is only possible because no votes have been cast yet. Once any vote is recorded,
                the period is locked in Ready and cannot be reverted.
              </p>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <p>Marking this period as Ready will:</p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>Make it visible to voters</li>
                <li>Allow voting once the voting window opens</li>
                <li>
                  <span className="text-foreground font-medium">Once a vote is cast, lock all edits</span>{' '}
                  to the committee, voting window, topics, and options
                </li>
              </ul>
              <p className="text-muted-foreground">
                You can revert to Draft later only if no votes have been cast yet.
              </p>
              {readyWarnings.length > 0 && (
                <Callout variant="warning" title="Heads up">
                  <ul className="list-disc space-y-0.5 pl-5">
                    {readyWarnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadyDialogOpen(false)}>Cancel</Button>
            <Button
              variant={ready ? 'outline' : 'default'}
              onClick={() =>
                setReadyMutation.mutate(
                  { periodId, ready: !ready },
                  { onSuccess: () => setReadyDialogOpen(false) },
                )
              }
              disabled={setReadyMutation.isPending}
              aria-busy={setReadyMutation.isPending}
            >
              <TxButtonContent
                pending={setReadyMutation.isPending}
                idleLabel={ready ? 'Revert to draft' : 'Mark ready'}
                pendingLabel="Saving…"
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove-topic confirm (replaces window.confirm) */}
      <ConfirmDialog
        open={removingTopic !== null}
        onOpenChange={(o) => { if (!o) setRemovingTopic(null) }}
        title={removingTopic !== null ? `Remove topic ${removingTopic + 1}?` : 'Remove topic?'}
        description="This can't be undone. The topic and its options will be permanently deleted from this draft."
        confirmLabel="Remove topic"
        onConfirm={() => {
          if (removingTopic !== null) removeTopicMutation.mutate({ periodId, topicIndex: removingTopic })
          setRemovingTopic(null)
        }}
      />

      {/* Edit Topic Body Dialog */}
      {editingTopicBody !== null && (
        <Dialog open={true} onOpenChange={() => setEditingTopicBody(null)}>
          <DialogContent onClose={() => setEditingTopicBody(null)}>
            <DialogHeader>
              <DialogTitle>
                {topicBodies[editingTopicBody] ? 'Edit' : 'Add'} Topic {editingTopicBody + 1} Body
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="edit-topic-title">Title</Label>
                <Input
                  id="edit-topic-title"
                  name="edit-topic-title"
                  value={editTopicTitle}
                  onChange={(e) => setEditTopicTitle(e.target.value)}
                  placeholder="Topic title"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-topic-body">Description</Label>
                <MarkdownEditor
                  id="edit-topic-body"
                  value={editTopicBody}
                  onChange={setEditTopicBody}
                  placeholder="Topic description..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingTopicBody(null)}>Cancel</Button>
              <TxButton
                onClick={handleSaveTopicBody}
                pending={uploadTopicBodyMutation.isPending}
                success={uploadTopicBodyMutation.isSuccess}
                idleLabel="Save"
                pendingLabel="Saving…"
                confirmedLabel="Saved"
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
