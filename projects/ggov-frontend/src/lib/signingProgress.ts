import { toast } from 'sonner'

let counter = 0

/**
 * Tracks a user action that requires signing more than one transaction group
 * (e.g. "add topic" signs the topic creation, then the body upload separately).
 *
 * Shows a single persistent toast that updates in place as each group is
 * signed: "Signing 1/2 — …", "Signing 2/2 — …". Call `step(label)` right
 * before each signed SDK call, then `done()` on success or `fail()` on error
 * to clear the toast. When `total <= 1` the controller is inert — single-group
 * flows keep their existing transient success/error notifications.
 */
export function signingProgress(total: number) {
  const active = total > 1
  const id = `signing-progress-${++counter}`
  let current = 0

  return {
    /** Advance to the next signed group and update the persistent toast. */
    step(label: string) {
      if (!active) return
      current += 1
      toast.loading(`Signing ${current}/${total} — ${label}`, { id, duration: Infinity })
    },
    /** Clear the toast once every group has been signed and confirmed. */
    done() {
      if (active) toast.dismiss(id)
    },
    /** Clear the toast when a step fails (the error surfaces separately). */
    fail() {
      if (active) toast.dismiss(id)
    },
  }
}
