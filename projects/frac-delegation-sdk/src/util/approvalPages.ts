/* Verbatim copy of ggov-sdk/src/util/approvalPages.ts — the two SDKs do not share runtime code. */
import { MAX_APP_CALL_FOREIGN_REFERENCES } from '@algorandfoundation/algokit-utils'

/**
 * Largest approval page one application argument can carry.
 *
 * The network rejects any single argument over 4096 bytes, and an ARC-4 `byte[]` is encoded with
 * a 2-byte length prefix — so a 4096-byte page goes out as 4098 and is refused with
 * "tx.ApplicationArgs[1] length is too long. 4098 > 4096". 4094 is what actually fits.
 */
export const APPROVAL_PAGE_BYTES = 4094

/** Box read/write budget bought by one box reference on an app call. */
export const BOX_IO_BYTES_PER_REF = 1024

/**
 * Split approval bytecode into the two pages the upload call carries.
 *
 * The contract concatenates them, so the split point carries no meaning beyond fitting each page
 * into one application argument.
 */
export function splitApprovalPages(bytecode: Uint8Array): { page1: Uint8Array; page2: Uint8Array } {
  if (bytecode.length > 2 * APPROVAL_PAGE_BYTES) {
    throw new Error(
      `Approval program is ${bytecode.length} bytes; the two-page upload carries at most ${2 * APPROVAL_PAGE_BYTES}.`,
    )
  }
  return {
    page1: bytecode.subarray(0, APPROVAL_PAGE_BYTES),
    page2: bytecode.subarray(APPROVAL_PAGE_BYTES),
  }
}

/**
 * Box references an app call needs to carry to write `bytes` into a box.
 *
 * Box I/O budget is {@link BOX_IO_BYTES_PER_REF} per reference, and creating plus filling a box of
 * N bytes spends N of write budget. Resource population only adds one reference per distinct box,
 * which covers 1024 bytes and no more, so a larger write must buy the budget explicitly by
 * repeating the reference. A full 8192-byte program needs 8 — exactly
 * {@link MAX_APP_CALL_FOREIGN_REFERENCES}, the AVM's combined cap on accounts + apps + assets +
 * boxes per call, leaving no room for any other reference on that transaction.
 */
export function boxIoRefsFor(bytes: number): number {
  const refs = Math.max(1, Math.ceil(bytes / BOX_IO_BYTES_PER_REF))
  if (refs > MAX_APP_CALL_FOREIGN_REFERENCES) {
    throw new Error(
      `Writing ${bytes} bytes needs ${refs} box references, over the ${MAX_APP_CALL_FOREIGN_REFERENCES} an app call can carry.`,
    )
  }
  return refs
}
