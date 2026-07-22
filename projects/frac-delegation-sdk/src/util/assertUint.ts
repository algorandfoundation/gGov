/** Verbatim copy of ggov-sdk/src/util/assertUint.ts */

/**
 * Validate that `value` is a non-negative integer that fits in an unsigned `bits`-bit ABI integer
 * (e.g. uint8 → 0…255), returning it as a bigint ready to pass as an ABI argument.
 *
 * Fixed-width ABI args are typed `bigint | number`, so a negative, non-integer, or out-of-range
 * value type-checks fine and only blows up deep inside ABI encoding with an opaque message. Calling
 * this at the call site surfaces a clear, actionable error instead.
 */
export function assertUint(value: bigint | number, bits: number, label: string): bigint {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer, got ${value}`)
  }
  const asBigInt = BigInt(value)
  const max = (1n << BigInt(bits)) - 1n
  if (asBigInt < 0n || asBigInt > max) {
    throw new RangeError(`${label} must be in the range 0…${max} (uint${bits}), got ${value}`)
  }
  return asBigInt
}
