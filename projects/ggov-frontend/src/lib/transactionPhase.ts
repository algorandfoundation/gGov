import { useSyncExternalStore } from 'react'
import type { TransactionSigner } from 'algosdk'

/**
 * Coarse lifecycle of the transaction the user is currently submitting:
 *
 *   idle → signing (wallet prompt open) → sending (signed, awaiting confirmation)
 *        → confirmed (brief success flash) → idle
 *
 * There is a single global phase because only one transaction flow runs at a time
 * in practice. Buttons gate the phase on their own `mutation.isPending`, so the
 * phase only ever decorates the button that triggered it.
 */
export type TransactionPhase = 'idle' | 'signing' | 'sending' | 'confirmed'

let phase: TransactionPhase = 'idle'
let confirmedTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function clearConfirmedTimer() {
  if (confirmedTimer !== undefined) {
    clearTimeout(confirmedTimer)
    confirmedTimer = undefined
  }
}

export function setPhase(next: TransactionPhase) {
  clearConfirmedTimer()
  if (phase === next) return
  phase = next
  emit()
}

/** Return to idle immediately (transaction start or failure). */
export function resetPhase() {
  setPhase('idle')
}

/**
 * Flash the `confirmed` state, then fall back to idle so the success checkmark is
 * visible briefly without lingering (mirrors xgov-beta-web's `sleep(800)`).
 */
export function confirmPhase() {
  clearConfirmedTimer()
  if (phase !== 'confirmed') {
    phase = 'confirmed'
    emit()
  }
  confirmedTimer = setTimeout(() => {
    confirmedTimer = undefined
    if (phase === 'confirmed') {
      phase = 'idle'
      emit()
    }
  }, 1600)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return phase
}

/** Subscribe to the current global transaction phase. */
export function useTransactionPhase() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Wrap a wallet's `TransactionSigner` so the global phase advances as the user
 * signs: `signing` while the wallet prompt is open, then `sending` once the signed
 * transactions are handed back to be submitted. Multi-group flows fire this once
 * per group, so the phase simply reflects the group currently being signed.
 */
export function wrapSignerWithPhase(signer: TransactionSigner): TransactionSigner {
  return async (txns, indexesToSign) => {
    setPhase('signing')
    const signed = await signer(txns, indexesToSign)
    setPhase('sending')
    return signed
  }
}
