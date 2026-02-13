import { sha512_256 } from "js-sha512";

export function calculateCommitteeId(contents: string): Uint8Array {
  const fileHash = Buffer.from(sha512_256(contents), "hex");
  const concatenated = Buffer.concat([Buffer.from("arc0086"), fileHash]);
  const committeeId = Buffer.from(sha512_256(concatenated), "hex");
  return new Uint8Array(committeeId);
}

export function committeeIdToRaw(committeeId: Uint8Array | Buffer | string): Uint8Array {
  let comitteeRaw: Uint8Array;
  if (typeof committeeId === "string") {
    comitteeRaw = new Uint8Array(Buffer.from(committeeId, "base64"));
  } else if (committeeId instanceof Buffer) {
    comitteeRaw = new Uint8Array(committeeId);
  } else { // uint8 already
    comitteeRaw = committeeId;
  }
  if (comitteeRaw.length !== 32) {
    throw new Error(`Invalid committeeId length, must be 32 bytes. Found ${comitteeRaw.length} bytes.`);
  }
  return comitteeRaw
}
