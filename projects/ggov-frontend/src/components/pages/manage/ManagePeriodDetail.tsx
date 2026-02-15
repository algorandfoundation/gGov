import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { usePeriod, usePeriodBody, useTopicBodies, useCommittees, toBase64Url } from '@/hooks/queries'
import { useEditPeriodMutation, useUploadPeriodBodyMutation, useEditTopicMutation, useUploadTopicBodyMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import PeriodStatusBadge from '@/components/PeriodStatusBadge'
import { formatTimestampUTC, toDatetimeLocalUTC, fromDatetimeLocalUTC, periodStatus } from '@/utils/time'

export default function ManagePeriodDetail() {
  const { periodId: pidParam } = useParams<{ periodId: string }>()
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()

  const { data: period, isLoading } = usePeriod(periodId)
  const { data: periodBody } = usePeriodBody(periodId)
  const { data: topicBodies = [] } = useTopicBodies(periodId, period?.topics.length ?? 0)
  const { data: committees = [] } = useCommittees()

  const editPeriodMutation = useEditPeriodMutation()
  const uploadPeriodBodyMutation = useUploadPeriodBodyMutation()
  const editTopicMutation = useEditTopicMutation()
  const uploadTopicBodyMutation = useUploadTopicBodyMutation()

  // Edit period form
  const [editCommittee, setEditCommittee] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')

  // Edit period body
  const [editPeriodTitle, setEditPeriodTitle] = useState('')
  const [editPeriodBody, setEditPeriodBody] = useState('')

  // Edit topic dialog
  const [editingTopic, setEditingTopic] = useState<number | null>(null)
  const [editOptions, setEditOptions] = useState<string[]>([])

  // Edit topic body dialog
  const [editingTopicBody, setEditingTopicBody] = useState<number | null>(null)
  const [editTopicTitle, setEditTopicTitle] = useState('')
  const [editTopicBody, setEditTopicBody] = useState('')

  useEffect(() => {
    if (period) {
      setEditCommittee(toBase64Url(period.committeeId))
      setEditStart(toDatetimeLocalUTC(period.votingStart))
      setEditEnd(toDatetimeLocalUTC(period.votingEnd))
    }
  }, [period])

  useEffect(() => {
    setEditPeriodTitle(periodBody?.title ?? '')
    setEditPeriodBody(periodBody?.body ?? '')
  }, [periodBody])

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

  function openEditTopic(topicIdx: number) {
    if (!period) return
    const [options] = period.topics[topicIdx]
    setEditingTopic(topicIdx)
    setEditOptions([...options])
  }

  function handleEditTopic() {
    if (editingTopic === null) return
    editTopicMutation.mutate(
      { periodId, topicIndex: editingTopic, options: editOptions },
      { onSuccess: () => setEditingTopic(null) },
    )
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
  const canEdit = status === 'upcoming' && !!sdk

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/manage" className="text-muted-foreground hover:text-foreground">&larr;</Link>
        <h1 className="text-2xl font-bold">{periodBody?.title}</h1>
        <PeriodStatusBadge votingStart={period.votingStart} votingEnd={period.votingEnd} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period Details</CardTitle>
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
                  <Label htmlFor="edit-voting-start">Voting Start (UTC)</Label>
                  <Input
                    id="edit-voting-start"
                    name="edit-voting-start"
                    type="datetime-local"
                    value={editStart}
                    onChange={(e) => setEditStart(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-voting-end">Voting End (UTC)</Label>
                  <Input
                    id="edit-voting-end"
                    name="edit-voting-end"
                    type="datetime-local"
                    value={editEnd}
                    onChange={(e) => setEditEnd(e.target.value)}
                  />
                </div>
              </div>
              <Button size="sm" onClick={handleEditPeriod} disabled={editPeriodMutation.isPending}>
                {editPeriodMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          ) : (
            <div className="text-sm">
              <span className="text-muted-foreground">Voting:</span>{' '}
              {formatTimestampUTC(period.votingStart)} — {formatTimestampUTC(period.votingEnd)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Period Body */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period Body</CardTitle>
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
                <Textarea
                  id="edit-period-body"
                  name="edit-period-body"
                  value={editPeriodBody}
                  onChange={(e) => setEditPeriodBody(e.target.value)}
                  placeholder="Period description..."
                  rows={4}
                  required
                />
              </div>
              <Button size="sm" onClick={handleSavePeriodBody} disabled={uploadPeriodBodyMutation.isPending}>
                {uploadPeriodBodyMutation.isPending ? 'Saving...' : periodBody ? 'Update Body' : 'Add Body'}
              </Button>
            </>
          ) : periodBody && (
            <div>
              <p className="font-medium">{periodBody.title}</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{periodBody.body}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Topics ({period.topics.length})</h2>
        <Link to={`/manage/period/${periodId}/add-topic`}>
          <Button variant="outline" size="sm">Add Topic</Button>
        </Link>
      </div>

      {period.topics.length === 0 ? (
        <p className="text-muted-foreground">No topics yet. Add one to get started.</p>
      ) : (
        <div className="space-y-4">
          {period.topics.map(([options, tallies], topicIdx) => {
            const tb = topicBodies[topicIdx]
            return (
              <Card key={topicIdx}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{tb?.title}</CardTitle>
                      {tb?.body && <CardDescription className="whitespace-pre-wrap mt-1">{tb.body}</CardDescription>}
                    </div>
                    <div className="flex gap-1">
                      {sdk && (
                        <Button variant="ghost" size="sm" onClick={() => openEditTopicBody(topicIdx)}>
                          {tb ? 'Edit Body' : 'Add Body'}
                        </Button>
                      )}
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => openEditTopic(topicIdx)}>
                          Edit Options
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {options.map((option, optIdx) => {
                      const tally = tallies[optIdx] ?? 0
                      const totalVotes = tallies.reduce((a, b) => a + b, 0)
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
        <Dialog open={true} onOpenChange={() => setEditingTopic(null)}>
          <DialogContent onClose={() => setEditingTopic(null)}>
            <DialogHeader>
              <DialogTitle>Edit Topic {editingTopic + 1} Options</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {editOptions.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    name={`topic-option-${i}`}
                    aria-label={`Option ${i + 1}`}
                    value={opt}
                    onChange={(e) => {
                      const next = [...editOptions]
                      next[i] = e.target.value
                      setEditOptions(next)
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditOptions(editOptions.filter((_, j) => j !== i))}
                    disabled={editOptions.length <= 1}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setEditOptions([...editOptions, ''])}>
                Add Option
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingTopic(null)}>Cancel</Button>
              <Button onClick={handleEditTopic} disabled={editTopicMutation.isPending}>
                {editTopicMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

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
                <Textarea
                  id="edit-topic-body"
                  name="edit-topic-body"
                  value={editTopicBody}
                  onChange={(e) => setEditTopicBody(e.target.value)}
                  placeholder="Topic description..."
                  rows={4}
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingTopicBody(null)}>Cancel</Button>
              <Button onClick={handleSaveTopicBody} disabled={uploadTopicBodyMutation.isPending}>
                {uploadTopicBodyMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
