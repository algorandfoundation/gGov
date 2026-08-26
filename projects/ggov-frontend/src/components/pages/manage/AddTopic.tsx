import { useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
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
import { periodTerms } from '@/utils/periodTerms'
import { ABSTAIN_OPTION, MIN_CUSTOM_OPTIONS, findOptionIssues, withAbstain } from '@/utils/topicOptions'
import { TxButton } from '@/components/TxButtonContent'

/**
 * Fixed ballot for an election candidate. Election periods score candidates by
 * net (Support − Veto), so every candidate topic must use exactly these
 * options — the operator gets no choice (see `isElection` below).
 */
const ELECTION_OPTIONS = ['Support', 'Veto', ABSTAIN_OPTION]

export default function AddTopic() {
  const { periodId: pidParam } = useParams({ strict: false })
  const periodId = Number(pidParam)
  const { sdk } = useGGovSDK()
  const navigate = useNavigate()
  const addTopicMutation = useAddTopicMutation()
  // An election period (body carries `elect`) hardcodes its topic options to
  // Support / Veto / Abstain; only standard periods expose the free-form editor.
  const { data: periodBody } = usePeriodBody(periodId)
  const elect = periodBody?.elect
  const terms = periodTerms(elect)
  // Kept as the direct check rather than `terms.isElection` so TS narrows `elect`
  // for the seat/race lookups below.
  const isElection = elect !== undefined

  // Only the operator-typed custom options; Abstain is a fixed row appended on submit.
  const [options, setOptions] = useState<string[]>(['', ''])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  // Which election this candidate runs in. A multi-election period demands an explicit
  // choice (empty until picked) — a period with one election has only one answer.
  const [election, setElection] = useState('')

  const electionIdx = election === '' ? undefined : Number(election)
  // With a single election there's nothing to choose, so it's implied; with several, an
  // unpicked election would silently land the candidate in whichever race is first.
  const resolvedElection = !isElection ? undefined : elect.length === 1 ? 0 : electionIdx
  const electionValid = !isElection || resolvedElection !== undefined

  // Unlike EditOptionsDialog, blank rows are dropped on submit rather than flagged.
  // Preferred this to not add noise in the add form; operator can still remove blank rows manually.
  const { trimmed, duplicateIdx, abstainIdx } = useMemo(() => findOptionIssues(options), [options])
  const customOptions = trimmed.filter((o) => o !== '')
  const optionsValid = customOptions.length >= MIN_CUSTOM_OPTIONS && duplicateIdx.size === 0 && abstainIdx.size === 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // `periodBody` is `undefined` until the query resolves; submitting in that window would
    // treat an election as a standard period (`isElection` false) and let arbitrary options
    // through. Wait until it resolves (to the body or `null`) before allowing submission.
    if (periodBody === undefined) return
    const finalOptions = isElection ? ELECTION_OPTIONS : withAbstain(customOptions)
    if ((!isElection && !optionsValid) || !title.trim() || !body.trim() || !electionValid) return

    await addTopicMutation.mutateAsync({
      periodId,
      options: finalOptions,
      title: title.trim(),
      body: body.trim(),
      e: resolvedElection,
    })

    void navigate({
      to: '/manage/period/$periodId',
      params: { periodId: String(periodId) },
      search: { mode: 'edit' },
    })
  }

  if (!sdk) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Add {terms.item}</h1>
        <p className="text-muted-foreground">Connect your wallet to add a {terms.item}.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <BackButton to={`/manage/period/${periodId}`} />
        <h1 className="text-2xl font-bold">
          Add {terms.item} to period #{periodId}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New {terms.item}</CardTitle>
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

            {/* Election picker — only meaningful when the period runs more than one race. */}
            {isElection && elect.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="topic-election">Election</Label>
                <select
                  id="topic-election"
                  name="topic-election"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={election}
                  onChange={(e) => setElection(e.target.value)}
                  required
                >
                  <option value="">Select an election</option>
                  {elect.map((e, i) => (
                    <option key={i} value={String(i)}>
                      {e.t} ({e.s} seat{e.s === 1 ? '' : 's'})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  This period runs {elect.length} elections. Each is ranked separately, so a candidate competes only
                  against others in the same election.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="topic-description">Description</Label>
              <MarkdownEditor
                id="topic-description"
                placeholder={isElection ? 'Candidate biography...' : 'Topic description...'}
                value={body}
                onChange={setBody}
              />
            </div>

            <div className="space-y-3">
              <Label>Vote options</Label>
              {periodBody === undefined ? (
                <p className="text-xs text-muted-foreground">Loading period type…</p>
              ) : isElection ? (
                // Election candidate ballot: fixed Support / Veto / Abstain, no editing.
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
                    Election candidates are voted Support / Veto / Abstain. Options are fixed so candidates can be
                    ranked by net score (Support − Veto).
                  </p>
                </div>
              ) : (
                <>
                  {options.map((opt, i) => (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          name={`option-${i}`}
                          placeholder={`Option ${i + 1}`}
                          value={opt}
                          aria-invalid={abstainIdx.has(i) || duplicateIdx.has(i) || undefined}
                          onChange={(e) => {
                            const next = [...options]
                            next[i] = e.target.value
                            setOptions(next)
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setOptions(options.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                      {duplicateIdx.has(i) ? (
                        <p className="text-xs text-destructive">Duplicate option.</p>
                      ) : abstainIdx.has(i) ? (
                        <p className="text-xs text-destructive">
                          {ABSTAIN_OPTION} is added automatically as the last option.
                        </p>
                      ) : null}
                    </div>
                  ))}
                  {/* Fixed last option. The hidden Remove sizes the column so the inputs line up. */}
                  <div className="flex items-center gap-2">
                    <Input name="option-abstain" value={ABSTAIN_OPTION} readOnly />
                    <span className="relative inline-flex items-center justify-center">
                      <Button type="button" variant="ghost" size="sm" className="invisible">
                        Remove
                      </Button>
                      <Lock className="absolute size-4 text-muted-foreground" />
                    </span>
                  </div>
                  {options.length < MIN_CUSTOM_OPTIONS && (
                    <p className="text-xs text-destructive">
                      A {terms.item} needs at least {MIN_CUSTOM_OPTIONS} options besides {ABSTAIN_OPTION}.
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setOptions([...options, ''])}>
                      Add option
                    </Button>
                    <span className="text-xs text-muted-foreground">or</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setOptions(['Yes', 'No'])}>
                      Use Yes / No
                    </Button>
                  </div>
                </>
              )}
            </div>

            <TxButton
              type="submit"
              disabled={periodBody === undefined || !electionValid || (!isElection && !optionsValid)}
              pending={addTopicMutation.isPending}
              success={addTopicMutation.isSuccess}
              idleLabel={`Add ${terms.item}`}
              pendingLabel="Adding…"
              confirmedLabel="Added"
            />
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
