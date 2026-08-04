/**
 * Date and time formatting. Every function takes unix **seconds**, the unit the period
 * contract stores voting windows in, and returns a display string.
 *
 * Two families, split by who is reading:
 *
 * - **Local** (`formatTimestamp`, `formatDateRange`, `formatMonthDay…`) — the voter-facing
 *   pages. "When can I vote" is a personal question, so a voter should see their own clock.
 * - **UTC** (`…UTC`) — the manage panel. The operator types the voting window in UTC and the
 *   table reads it back in UTC, so the numbers never shift with where the operator happens
 *   to be.
 */

export type PeriodStatus = 'upcoming' | 'active' | 'ended'

export function periodStatus(votingStart: number, votingEnd: number): PeriodStatus {
  const now = Math.floor(Date.now() / 1000)
  if (now < votingStart) return 'upcoming'
  if (now <= votingEnd) return 'active'
  return 'ended'
}

export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function toDatetimeLocal(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromDatetimeLocal(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000)
}

/** "Jun 2" — month + day, no year. */
export function formatMonthDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Jun 30, 2026" — month, day and year. */
export function formatMonthDayYear(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Jun 2 – Jun 30, 2026" (drops the start year when both fall in the same year). */
export function formatDateRange(startSeconds: number, endSeconds: number): string {
  const sameYear = new Date(startSeconds * 1000).getFullYear() === new Date(endSeconds * 1000).getFullYear()
  const start = sameYear ? formatMonthDay(startSeconds) : formatMonthDayYear(startSeconds)
  return `${start} – ${formatMonthDayYear(endSeconds)}`
}

/** "Jun 2 – Jun 30, 2026" in UTC. The UTC twin of `formatDateRange`. */
export function formatDateRangeUTC(startSeconds: number, endSeconds: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  const start = new Date(startSeconds * 1000)
  const end = new Date(endSeconds * 1000)
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear()
  return `${start.toLocaleDateString(undefined, sameYear ? opts : { ...opts, year: 'numeric' })} – ${end.toLocaleDateString(undefined, { ...opts, year: 'numeric' })}`
}

/** Whole days from now until `unixSeconds` (negative once it has passed). */
export function daysUntil(unixSeconds: number): number {
  return Math.ceil((unixSeconds - Date.now() / 1000) / 86_400)
}

/** "14:08:22" — exact wall-clock time of day in the viewer's local timezone, seconds-precise. */
export function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Approximate elapsed days for a round span (Algorand ≈ 2.81s/round). */
export function roundsToDays(rounds: number): number {
  return Math.round((rounds * 2.81) / 86_400)
}

export function formatTimestampUTC(unixSeconds: number): string {
  return (
    new Date(unixSeconds * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC'
  )
}

export function toDatetimeLocalUTC(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function fromDatetimeLocalUTC(value: string): number {
  return Math.floor(new Date(value + 'Z').getTime() / 1000)
}
