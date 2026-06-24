/**
 * Storybook mock for `@/hooks/mutations`.
 *
 * Aliased in `.storybook/main.ts` so dialogs that fire on-chain mutations (e.g.
 * EditOptionsDialog) render without pulling in the SDK / signer / network stack.
 * The stub mutation runs a fake signing→sending→confirmed flow that drives the
 * real global transaction phase, so the `TxButtonContent` label animates exactly
 * as it does in the app (`Sign in Lute…` → `Saving…` → `Saved`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { setPhase, confirmPhase, resetPhase } from '@/lib/transactionPhase'

interface FakeMutateOptions {
  onSuccess?: () => void
  onError?: (err: unknown) => void
}

interface FakeMutation {
  mutate: (vars?: unknown, options?: FakeMutateOptions) => void
  mutateAsync: (vars?: unknown, options?: FakeMutateOptions) => Promise<void>
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  reset: () => void
}

/** A mutation that mimics the app's phase timeline without touching the chain. */
function useFakeMutation(): FakeMutation {
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)

  // Track scheduled timers so a story switch / HMR unmount, a re-run, or a reset
  // can cancel pending callbacks — otherwise they fire setState on an unmounted
  // component and re-flip the global transaction phase after the UI has moved on.
  const timers = useRef<number[]>([])
  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  const mutate = useCallback(
    (_vars?: unknown, options?: FakeMutateOptions) => {
      clearTimers()
      setIsSuccess(false)
      setIsPending(true)
      setPhase('signing')
      // signing (wallet prompt) → sending (submitted) → confirmed (✓ flash) → idle
      timers.current.push(window.setTimeout(() => setPhase('sending'), 900))
      timers.current.push(
        window.setTimeout(() => {
          setIsPending(false)
          setIsSuccess(true)
          confirmPhase()
          options?.onSuccess?.()
        }, 1900),
      )
    },
    [clearTimers],
  )

  const mutateAsync = useCallback(
    (vars?: unknown, options?: FakeMutateOptions) =>
      new Promise<void>((resolve) => {
        mutate(vars, {
          ...options,
          onSuccess: () => {
            options?.onSuccess?.()
            resolve()
          },
        })
      }),
    [mutate],
  )

  const reset = useCallback(() => {
    clearTimers()
    setIsPending(false)
    setIsSuccess(false)
    resetPhase()
  }, [clearTimers])

  return { mutate, mutateAsync, isPending, isSuccess, isError: false, reset }
}

export const useEditTopicMutation = useFakeMutation
export const useCreatePeriodMutation = useFakeMutation
export const useAddTopicMutation = useFakeMutation
export const useDelegateMutation = useFakeMutation
export const useVoteMutation = useFakeMutation
