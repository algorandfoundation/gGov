import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useAddTopicMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import BackButton from '@/components/BackButton'
import { TxButton } from '@/components/TxButtonContent'

export default function AddTopic() {
  const { periodId: pidParam } = useParams<{ periodId: string }>()
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()
  const navigate = useNavigate()
  const addTopicMutation = useAddTopicMutation()

  const [options, setOptions] = useState<string[]>(['', ''])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const filtered = options.filter((o) => o.trim())
    if (filtered.length < 2 || !title.trim() || !body.trim()) return

    await addTopicMutation.mutateAsync({
      periodId,
      options: filtered,
      title: title.trim(),
      body: body.trim(),
    })

    navigate(`/manage/period/${periodId}`)
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
        <h1 className="text-2xl font-bold">Add topic to period #{periodId}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New topic</CardTitle>
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
                placeholder="Topic title"
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOptions([...options, ''])}
                >
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
            </div>

            <TxButton
              type="submit"
              disabled={options.filter((o) => o.trim()).length < 2}
              pending={addTopicMutation.isPending}
              success={addTopicMutation.isSuccess}
              idleLabel="Add topic"
              pendingLabel="Adding…"
              confirmedLabel="Added"
            />
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
