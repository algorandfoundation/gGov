/**
 * Largest approval page one application argument can carry.
 *
 * The network rejects any single argument over 4096 bytes, and an ARC-4 `byte[]` is encoded with
 * a 2-byte length prefix — so a 4096-byte page goes out as 4098 and is refused with
 * "tx.ApplicationArgs[1] length is too long. 4098 > 4096". 4094 is what actually fits.
 */
export const APPROVAL_PAGE_BYTES = 4094

/** Pages the upload method takes, and the registry's create method reads back out of the box. */
export const APPROVAL_PAGES = 3

/**
 * Largest approval program the upload carries.
 *
 * Three is as many pages as fit: AVM v13 caps a call's total application arguments at 16384 bytes,
 * and four encoded pages (4 * 4096) plus a method selector is over it. The 12282 bytes that leaves
 * carry a program well into v13's 7 extra program pages (16384 bytes of program space, shared with
 * the clear-state program) — short only of one that fills them.
 */
export const MAX_APPROVAL_BYTES = APPROVAL_PAGES * APPROVAL_PAGE_BYTES

/**
 * Split approval bytecode into the pages the upload call carries.
 *
 * The contract concatenates them, so the split points carry no meaning beyond fitting each page
 * into one application argument. Trailing pages come back empty for a program that fits in fewer,
 * and the contract treats an empty page as a no-op.
 */
export function splitApprovalPages(bytecode: Uint8Array): {
  page1: Uint8Array
  page2: Uint8Array
  page3: Uint8Array
} {
  if (bytecode.length > MAX_APPROVAL_BYTES) {
    throw new Error(
      `Approval program is ${bytecode.length} bytes; the ${APPROVAL_PAGES}-page upload carries at most ${MAX_APPROVAL_BYTES}.`,
    )
  }
  return {
    page1: bytecode.subarray(0, APPROVAL_PAGE_BYTES),
    page2: bytecode.subarray(APPROVAL_PAGE_BYTES, 2 * APPROVAL_PAGE_BYTES),
    page3: bytecode.subarray(2 * APPROVAL_PAGE_BYTES),
  }
}
