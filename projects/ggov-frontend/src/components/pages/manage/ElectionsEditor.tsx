import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Callout } from '@/components/ui/callout'
import { type ElectionDraft, emptyElectionDraft, draftValid } from '@/utils/electionDrafts'

interface ElectionsEditorProps {
  /** Whether this period runs elections at all — drives the `elect` field's presence. */
  isElection: boolean
  onIsElectionChange: (value: boolean) => void
  rows: ElectionDraft[]
  onRowsChange: (rows: ElectionDraft[]) => void
  /** Prefix for input ids, so two editors can coexist on one page. */
  idPrefix: string
  /** Number of candidates already added, when known — enables the "reindex" warning. */
  candidateCount?: number
}

/**
 * Editor for a period's election list (the period body's `elect`). Each row is one
 * election with its own title and seat count; a period with a single row is the
 * ordinary one-election period.
 *
 * Rows are **append-stable on purpose**: a candidate names its election by index, so
 * removing or reordering a row silently re-tags every candidate pointing past it.
 * Removal is therefore only offered for trailing rows, and only with a warning once
 * candidates exist.
 */
export default function ElectionsEditor({
  isElection,
  onIsElectionChange,
  rows,
  onRowsChange,
  idPrefix,
  candidateCount,
}: ElectionsEditorProps) {
  const update = (i: number, patch: Partial<ElectionDraft>) =>
    onRowsChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-input"
          checked={isElection}
          onChange={(e) => onIsElectionChange(e.target.checked)}
        />
        Election type
      </label>

      {isElection && (
        <div className="space-y-3">
          <Label>Elections</Label>
          {rows.map((row, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 space-y-1">
                <Input
                  id={`${idPrefix}-election-title-${i}`}
                  name={`${idPrefix}-election-title-${i}`}
                  value={row.title}
                  onChange={(e) => update(i, { title: e.target.value })}
                  placeholder={rows.length === 1 ? 'Election name (e.g. Council)' : `Election ${i + 1} name`}
                  required
                />
              </div>
              <div className="w-28 space-y-1">
                <Input
                  id={`${idPrefix}-election-seats-${i}`}
                  name={`${idPrefix}-election-seats-${i}`}
                  type="number"
                  min={1}
                  step={1}
                  value={row.seats}
                  onChange={(e) => update(i, { seats: e.target.value })}
                  placeholder="Seats"
                  required
                />
              </div>
              {/* Only the trailing row may go: dropping one from the middle would
                  renumber the rows after it and re-tag their candidates. */}
              {rows.length > 1 && i === rows.length - 1 ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => onRowsChange(rows.slice(0, -1))}>
                  Remove
                </Button>
              ) : (
                <span className="w-[68px]" aria-hidden />
              )}
            </div>
          ))}

          {rows.some((r) => !draftValid(r)) && (
            <p className="text-sm text-destructive">
              Each election needs a name and a whole number of seats (1 or more).
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRowsChange([...rows, emptyElectionDraft()])}
          >
            Add election
          </Button>

          <p className="text-xs text-muted-foreground">
            {rows.length > 1
              ? 'Each candidate picks which election it runs in. Elections are ranked separately by net score (Support − Against), each filling its own seats.'
              : 'Every candidate you add will be a fixed Support / Against / Abstain ballot, ranked by net score (Support − Against).'}
          </p>

          {candidateCount !== undefined && candidateCount > 0 && (
            <Callout variant="warning" title="Editing an election list with candidates">
              Candidates reference an election by position, so removing or reordering elections re-assigns the
              candidates that pointed past it. Add new elections at the end, and re-assign candidates before dropping
              one.
            </Callout>
          )}
        </div>
      )}
    </div>
  )
}
