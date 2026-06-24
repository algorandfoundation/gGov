import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { getErrorMessage, isUserRejectionError } from '@/lib/errors'
import { subscribeSurfacedError } from '@/lib/errorBus'

interface ErrorDialogContextValue {
  showError: (err: unknown) => void
  clearError: () => void
}

const ErrorDialogContext = createContext<ErrorDialogContextValue | null>(null)

export function ErrorDialogProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<Error | null>(null)

  const showError = useCallback((err: unknown) => {
    // User cancelled the signing prompt — not a failure worth a modal.
    if (isUserRejectionError(err)) {
      toast('Signing cancelled')
      return
    }
    setError(err instanceof Error ? err : new Error(getErrorMessage(err)))
  }, [])

  const clearError = useCallback(() => setError(null), [])

  // Surface failed primary queries (tagged `meta.surfaceError`) through this same
  // dialog. The subscription is client-only, so the QueryCache's server-side
  // `onError` has no listener and never tries to render a modal during SSR.
  useEffect(() => subscribeSurfacedError(showError), [showError])

  return (
    <ErrorDialogContext.Provider value={{ showError, clearError }}>
      {children}
      {error && (
        <Dialog open onOpenChange={() => clearError()}>
          <DialogContent onClose={clearError} className="max-w-md border-t-[3px] border-t-destructive">
            <div className="flex items-start gap-3">
              <span className="flex size-9 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive-strong">
                <AlertTriangle className="size-[19px]" />
              </span>
              <DialogHeader className="min-w-0 flex-1 text-left sm:text-left">
                <DialogTitle>Something went wrong</DialogTitle>
                <DialogDescription>
                  Your transaction couldn't be completed. The technical detail below can be copied for support.
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {error.message}
            </div>
            <DialogFooter>
              <CopyButton value={error.message} size="default">
                Copy error
              </CopyButton>
              <Button onClick={clearError}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ErrorDialogContext.Provider>
  )
}

export function useErrorDialog() {
  const ctx = useContext(ErrorDialogContext)
  if (!ctx) throw new Error('useErrorDialog must be used within ErrorDialogProvider')
  return ctx
}
