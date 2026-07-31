import type { Election } from 'ggov-sdk'

/**
 * Edit-time shape of one election row, backing the operator's elections editor.
 *
 * `seats` stays a string so a half-typed or cleared number field doesn't collapse to
 * `NaN`/`0` mid-keystroke; {@link draftsToElect} converts to the on-chain `{ t, s }`
 * wire shape on submit.
 */
export interface ElectionDraft {
  title: string
  seats: string
}

export const emptyElectionDraft = (): ElectionDraft => ({ title: '', seats: '' })

/** Seed the editor from a period body's `elect` list (absent → a single blank row). */
export function electToDrafts(elect?: Election[]): ElectionDraft[] {
  if (!elect || elect.length === 0) return [emptyElectionDraft()]
  return elect.map((e) => ({ title: e.t, seats: String(e.s) }))
}

/** Convert edited rows to the on-chain wire shape. Assumes {@link draftsValid}. */
export function draftsToElect(rows: ElectionDraft[]): Election[] {
  return rows.map((r) => ({ t: r.title.trim(), s: Number(r.seats) }))
}

/** Per-row validity: a non-empty title and a whole seat count of at least 1. */
export function draftValid(row: ElectionDraft): boolean {
  const seats = Number(row.seats)
  return row.title.trim().length > 0 && row.seats.trim() !== '' && Number.isSafeInteger(seats) && seats >= 1
}

/**
 * Whether the editor's current state can be saved. A period that isn't an election
 * needs no rows at all; an election needs at least one row and every row valid.
 */
export function draftsValid(isElection: boolean, rows: ElectionDraft[]): boolean {
  if (!isElection) return true
  return rows.length > 0 && rows.every(draftValid)
}
