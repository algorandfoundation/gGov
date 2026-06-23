/**
 * Module-level bridge from the QueryClient's cache to the in-app error dialog.
 *
 * The QueryClient (and its QueryCache) is built outside React in `router.tsx`,
 * so its `onError` can't reach the ErrorDialogProvider's context directly. The
 * cache calls `emitSurfacedError`; the provider subscribes on mount. Only
 * queries tagged `meta: { surfaceError: true }` are forwarded (see router.tsx),
 * so optional/background reads stay silent. On the server there are no
 * subscribers, so emitting is a harmless no-op.
 */
type SurfacedErrorListener = (error: unknown) => void

const listeners = new Set<SurfacedErrorListener>()

export function subscribeSurfacedError(listener: SurfacedErrorListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitSurfacedError(error: unknown): void {
  listeners.forEach((listener) => listener(error))
}
