import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useCommittees } from '@/hooks/queries'
import { useAddPeriodMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import { fromDatetimeLocalUTC } from '@/utils/time'

export default function AddPeriod() {
  const { sdk } = useGGovSDK()
  const navigate = useNavigate()
  const { data: committees = [], isLoading: loadingCommittees } = useCommittees()
  const addPeriodMutation = useAddPeriodMutation()

  const [selectedCommittee, setSelectedCommittee] = useState('')
  const [votingStart, setVotingStart] = useState('')
  const [votingEnd, setVotingEnd] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedCommittee || !votingStart || !votingEnd || !title.trim() || !body.trim()) return

    const committee = committees.find((c) => c.idBase64Url === selectedCommittee)
    if (!committee) return

    const periodId = await addPeriodMutation.mutateAsync({
      committeeId: committee.id,
      votingStart: BigInt(fromDatetimeLocalUTC(votingStart)),
      votingEnd: BigInt(fromDatetimeLocalUTC(votingEnd)),
      title: title.trim(),
      body: body.trim(),
    })

    navigate(`/manage/period/${periodId}`)
  }

  if (!sdk) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Add Period</h1>
        <p className="text-muted-foreground">Connect your wallet to create a period.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Add Period</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New Governance Period</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="committee">Committee</Label>
              <select
                id="committee"
                name="committee"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selectedCommittee}
                onChange={(e) => setSelectedCommittee(e.target.value)}
                required
                disabled={loadingCommittees}
              >
                <option value="">{loadingCommittees ? 'Loading committees...' : 'Select a committee'}</option>
                {committees.map((c) => (
                  <option key={c.idBase64Url} value={c.idBase64Url}>
                    Rounds {c.periodStart} — {c.periodEnd}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="voting-start">Voting Start (UTC)</Label>
                <Input
                  id="voting-start"
                  name="voting-start"
                  type="datetime-local"
                  value={votingStart}
                  onChange={(e) => setVotingStart(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="voting-end">Voting End (UTC)</Label>
                <Input
                  id="voting-end"
                  name="voting-end"
                  type="datetime-local"
                  value={votingEnd}
                  onChange={(e) => setVotingEnd(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="period-title">Title</Label>
              <Input
                id="period-title"
                name="period-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Period title"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="period-description">Description</Label>
              <MarkdownEditor
                id="period-description"
                placeholder="Period description..."
                value={body}
                onChange={setBody}
              />
            </div>

            <Button type="submit" disabled={addPeriodMutation.isPending}>
              {addPeriodMutation.isPending ? 'Creating...' : 'Create Period'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
