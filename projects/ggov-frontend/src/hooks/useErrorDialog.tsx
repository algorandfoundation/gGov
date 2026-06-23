import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
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
          <DialogContent onClose={clearError}>
            <DialogHeader className="min-w-0">
              <DialogTitle>Error</DialogTitle>
              <div className="max-w-full overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                {error.message}
              </div>
            </DialogHeader>
            <DialogFooter>
              <CopyButton value={error.message} size="default">Copy error</CopyButton>
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
