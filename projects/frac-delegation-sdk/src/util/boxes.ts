/** Detects the algod "box not found" 404 raised when reading a box key that has no entry. */
export function isBoxNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /box not found/i.test(msg)
}

/** Runs `read`, returning `undefined` when the underlying box does not exist (algod 404). */
export async function undefinedIfBoxMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (e) {
    if (isBoxNotFoundError(e)) return undefined
    throw e
  }
}

/** Box name for the registry's `instances` entry: 'i' (0x69) followed by the big-endian uint16 instanceNumId. */
export function instanceBoxName(instanceNumId: number | bigint): Uint8Array {
  const name = new Uint8Array(3)
  name[0] = 0x69 // 'i'
  new DataView(name.buffer).setUint16(1, Number(instanceNumId))
  return name
}
