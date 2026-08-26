/** Parse an optional app-id env var. Returns undefined when unset/empty; throws a targeted
 * error when set to anything but a positive integer (instead of BigInt's opaque SyntaxError). */
export function appIdFromEnv(name: string): bigint | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) {
    throw new Error(`${name} must be a positive integer app id, got: "${process.env[name]}"`)
  }
  return BigInt(raw)
}
