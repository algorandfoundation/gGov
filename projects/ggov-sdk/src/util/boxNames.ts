/** Box name for a single-ASCII-byte key ('o', 't', 'P'). */
export const asciiBoxName = (key: string): Uint8Array => new Uint8Array([key.charCodeAt(0)]);

/** Box name for a per-topic body box: 'T' (0x54) followed by the big-endian uint32 topic index (matches the contract + getTopicBody reader). */
export const topicBodyBoxName = (index: number | bigint): Uint8Array => {
  const name = new Uint8Array(5);
  name[0] = 0x54; // 'T'
  new DataView(name.buffer).setUint32(1, Number(index));
  return name;
};
