/** Box name for a single-ASCII-byte key ('o', 't', 'P'). */
export const asciiBoxName = (key: string): Uint8Array => new Uint8Array([key.charCodeAt(0)])

/** Box name for a per-topic body box: 'T' (0x54) followed by the big-endian uint32 topic index (matches the contract + getTopicBody reader). */
export const topicBodyBoxName = (index: number | bigint): Uint8Array => {
  const name = new Uint8Array(5)
  name[0] = 0x54 // 'T'
  new DataView(name.buffer).setUint32(1, Number(index))
  return name
}

/** Box name for the registry's `periods` entry: 'p' (0x70) followed by the big-endian uint32 periodId. */
export const periodBoxName = (periodId: number | bigint): Uint8Array => {
  const name = new Uint8Array(5)
  name[0] = 0x70 // 'p'
  new DataView(name.buffer).setUint32(1, Number(periodId))
  return name
}

/** The registry box holding the GGovPeriod approval bytecode: the ASCII key 'Pap'. */
export const PERIOD_APPROVAL_BOX_NAME = new TextEncoder().encode('Pap')
