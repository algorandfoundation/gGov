import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ErrorDialogContextValue {
  showError: (err: unknown) => void
  clearError: () => void
}

const ErrorDialogContext = createContext<ErrorDialogContextValue | null>(null)

export function ErrorDialogProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<Error | null>(null)

  const showError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err : new Error(String(err)))
  }, [])

  const clearError = useCallback(() => setError(null), [])

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
