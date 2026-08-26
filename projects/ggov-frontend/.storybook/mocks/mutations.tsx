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

interface FakeMutation<V> {
  mutate: (vars?: V, options?: FakeMutateOptions) => void
  mutateAsync: (vars?: V, options?: FakeMutateOptions) => Promise<void>
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  /** Latest `mutate` payload, as react-query exposes it (rows key their per-row spinner off this). */
  variables: V | undefined
  reset: () => void
}

/** A mutation that mimics the app's phase timeline without touching the chain. */
function useFakeMutation<V = unknown>(): FakeMutation<V> {
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [variables, setVariables] = useState<V | undefined>(undefined)

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
    (vars?: V, options?: FakeMutateOptions) => {
      clearTimers()
      setIsSuccess(false)
      setIsPending(true)
      setVariables(vars)
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
    (vars?: V, options?: FakeMutateOptions) =>
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
    setVariables(undefined)
    resetPhase()
  }, [clearTimers])

  return { mutate, mutateAsync, isPending, isSuccess, isError: false, variables, reset }
}

export const useEditTopicMutation = useFakeMutation
export const useCreatePeriodMutation = useFakeMutation
export const useAddTopicMutation = useFakeMutation
export const useDelegateMutation = useFakeMutation
export const useUndelegateMutation = useFakeMutation
export const useVoteMutation = useFakeMutation
/** Pooled ballot cast on a staking pool's frac instance — same fake phase timeline. */
export const useFracVoteMutation = useFakeMutation
// Registry funding panel (RegistryFundingPanel) — a plain payment in the real module.
export const useTopUpRegistryMutation = useFakeMutation

/**
 * Typed payload because the account page's delegator rows read `variables` to tell
 * "removing this delegation" (votingAddress === the delegator) from "forwarding it
 * onward", and to scope the spinner to the row that was actually clicked.
 */
export const useRedelegateMutation = () => useFakeMutation<{ account: string; votingAddress: string }>()
