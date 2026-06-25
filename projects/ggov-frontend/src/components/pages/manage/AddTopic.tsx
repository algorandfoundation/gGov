import { useState } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { usePeriodBody } from '@/hooks/queries'
import { useAddTopicMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import BackButton from '@/components/BackButton'
import { TxButton } from '@/components/TxButtonContent'

/**
 * Fixed ballot for an election candidate. Election periods score candidates by
 * net (Support − Against), so every candidate topic must use exactly these
 * options — the operator gets no choice (see `isElection` below).
 */
const ELECTION_OPTIONS = ['Support', 'Against', 'Abstain']

export default function AddTopic() {
  const { periodId: pidParam } = useParams({ strict: false })
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()
  const navigate = useNavigate()
  const addTopicMutation = useAddTopicMutation()
  // An election period (body carries `electSeats`) hardcodes its topic options to
  // Support / Against / Abstain; only standard periods expose the free-form editor.
  const { data: periodBody } = usePeriodBody(periodId)
  const isElection = periodBody?.electSeats !== undefined

  const [options, setOptions] = useState<string[]>(['', ''])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const filtered = isElection ? ELECTION_OPTIONS : options.filter((o) => o.trim())
    if (filtered.length < 2 || !title.trim() || !body.trim()) return

    await addTopicMutation.mutateAsync({
      periodId,
      options: filtered,
      title: title.trim(),
      body: body.trim(),
    })

    void navigate({ to: '/manage/period/$periodId', params: { periodId: String(periodId) } })
  }

  if (!sdk) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Add topic</h1>
        <p className="text-muted-foreground">Connect your wallet to add a topic.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <BackButton to={`/manage/period/${periodId}`} />
        <h1 className="text-2xl font-bold">
          Add {isElection ? 'candidate' : 'topic'} to period #{periodId}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isElection ? 'New candidate' : 'New topic'}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="topic-title">Title</Label>
              <Input
                id="topic-title"
                name="topic-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={isElection ? 'Candidate name' : 'Topic title'}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="topic-description">Description</Label>
              <MarkdownEditor
                id="topic-description"
                placeholder="Topic description..."
                value={body}
                onChange={setBody}
              />
            </div>

            <div className="space-y-3">
              <Label>Vote options</Label>
              {isElection ? (
                // Election candidate ballot: fixed Support / Against / Abstain, no editing.
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {ELECTION_OPTIONS.map((opt) => (
                      <span
                        key={opt}
                        className="inline-flex items-center rounded-md border border-input bg-muted/50 px-3 py-1.5 text-sm font-medium"
                      >
                        {opt}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Election candidates are voted Support / Against / Abstain. Options are fixed so candidates can be
                    ranked by net score (Support − Against).
                  </p>
                </div>
              ) : (
                <>
                  {options.map((opt, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        name={`option-${i}`}
                        placeholder={`Option ${i + 1}`}
                        value={opt}
                        onChange={(e) => {
                          const next = [...options]
                          next[i] = e.target.value
                          setOptions(next)
                        }}
                      />
                      {options.length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setOptions(options.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setOptions([...options, ''])}>
                      Add option
                    </Button>
                    <span className="text-xs text-muted-foreground">or</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setOptions(['Yes', 'No', 'Abstain'])}
                    >
                      Use Yes / No / Abstain
                    </Button>
                  </div>
                </>
              )}
            </div>

            <TxButton
              type="submit"
              disabled={!isElection && options.filter((o) => o.trim()).length < 2}
              pending={addTopicMutation.isPending}
              success={addTopicMutation.isSuccess}
              idleLabel={isElection ? 'Add candidate' : 'Add topic'}
              pendingLabel="Adding…"
              confirmedLabel="Added"
            />
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
