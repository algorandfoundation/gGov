import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useCommittees } from '@/hooks/queries'
import { useAddPeriodMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import { fromDatetimeLocalUTC } from '@/utils/time'
import { TxButton } from '@/components/TxButtonContent'

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
  const [isElection, setIsElection] = useState(false)
  const [electSeats, setElectSeats] = useState('')

  const electSeatsNum = Number(electSeats)
  const electSeatsValid = !isElection || (Number.isSafeInteger(electSeatsNum) && electSeatsNum >= 1)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedCommittee || !votingStart || !votingEnd || !title.trim() || !body.trim()) return
    if (!electSeatsValid) return

    const committee = committees.find((c) => c.idBase64Url === selectedCommittee)
    if (!committee) return

    const periodId = await addPeriodMutation.mutateAsync({
      committeeId: committee.id,
      votingStart: BigInt(fromDatetimeLocalUTC(votingStart)),
      votingEnd: BigInt(fromDatetimeLocalUTC(votingEnd)),
      title: title.trim(),
      body: body.trim(),
      electSeats: isElection ? electSeatsNum : undefined,
    })

    navigate({ to: '/manage/period/$periodId', params: { periodId: String(periodId) } })
  }

  if (!sdk) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Add period</h1>
        <p className="text-muted-foreground">Connect your wallet to create a period.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Add period</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New governance period</CardTitle>
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
                <Label htmlFor="voting-start">Voting start (UTC)</Label>
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
                <Label htmlFor="voting-end">Voting end (UTC)</Label>
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

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={isElection}
                  onChange={(e) => setIsElection(e.target.checked)}
                />
                Election type
              </label>
              {isElection && (
                <div className="space-y-2">
                  <Label htmlFor="elect-seats">Seats to elect</Label>
                  <Input
                    id="elect-seats"
                    name="elect-seats"
                    type="number"
                    min={1}
                    step={1}
                    value={electSeats}
                    onChange={(e) => setElectSeats(e.target.value)}
                    placeholder="Number of seats being elected"
                    required
                  />
                  {!electSeatsValid && (
                    <p className="text-sm text-destructive">Enter a whole number of seats (1 or more).</p>
                  )}
                </div>
              )}
            </div>

            <TxButton
              type="submit"
              disabled={!electSeatsValid}
              pending={addPeriodMutation.isPending}
              success={addPeriodMutation.isSuccess}
              idleLabel="Create period"
              pendingLabel="Creating…"
              confirmedLabel="Created"
            />
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
