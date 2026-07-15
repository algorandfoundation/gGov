/** Partial verbatim copy of ggov-sdk/src/util/comitteeId.ts (committee ID normalisation only) */

export function committeeIdToRaw(committeeId: Uint8Array | Buffer | string): Uint8Array {
  let comitteeRaw: Uint8Array
  if (typeof committeeId === 'string') {
    comitteeRaw = new Uint8Array(Buffer.from(committeeId, 'base64'))
  } else if (committeeId instanceof Buffer) {
    comitteeRaw = new Uint8Array(committeeId)
  } else {
    // uint8 already
    comitteeRaw = committeeId
  }
  if (comitteeRaw.length !== 32) {
    throw new Error(`Invalid committeeId length, must be 32 bytes. Found ${comitteeRaw.length} bytes.`)
  }
  return comitteeRaw
}
