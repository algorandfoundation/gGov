/** Normalize an unknown thrown value to a displayable message string. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

// Phrases wallets use when the user dismisses / rejects the signing prompt.
// Kept deliberately conservative so genuine on-chain failures still surface.
const USER_REJECTION_PATTERNS = [
  /user\s+rejected/i,
  /request\s+rejected/i,
  /transaction\s+request\s+rejected/i, // Pera
  /operation\s+cancell?ed/i,
  /user\s+(closed|denied|declined)/i,
  /denied\s+by\s+the\s+user/i,
  /modal\s+closed/i, // WalletConnect dismissals
]

/**
 * True when an error represents the user cancelling/rejecting the signing request
 * in their wallet rather than a real transaction failure. These should not raise
 * the error dialog.
 */
export function isUserRejectionError(err: unknown): boolean {
  const message = getErrorMessage(err)
  return USER_REJECTION_PATTERNS.some((re) => re.test(message))
}
