import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useAddTopicMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

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
        <h1 className="text-2xl font-bold">Add Topic</h1>
        <p className="text-muted-foreground">Connect your wallet to add a topic.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to={`/manage/period/${periodId}`} className="text-muted-foreground hover:text-foreground">&larr;</Link>
        <h1 className="text-2xl font-bold">Add Topic to Period #{periodId}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New Topic</CardTitle>
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
              <Textarea
                id="topic-description"
                name="topic-description"
                placeholder="Topic description..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                required
              />
            </div>

            <div className="space-y-3">
              <Label>Vote Options</Label>
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
                  Add Option
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

            <Button type="submit" disabled={addTopicMutation.isPending || options.filter((o) => o.trim()).length < 2}>
              {addTopicMutation.isPending ? 'Adding...' : 'Add Topic'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
