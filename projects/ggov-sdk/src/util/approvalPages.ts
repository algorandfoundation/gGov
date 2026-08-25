import { MAX_APP_CALL_FOREIGN_REFERENCES } from '@algorandfoundation/algokit-utils'
import { MAX_GROUP_SIZE } from '../constants.js'

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

/** Box read/write budget bought by one box reference on an app call. */
export const BOX_IO_BYTES_PER_REF = 1024

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

/**
 * Box references a group must carry to move `bytes` in or out of a box.
 *
 * Box I/O budget is {@link BOX_IO_BYTES_PER_REF} per reference and is pooled across the whole
 * transaction group; creating plus filling a box of N bytes spends N of it, and reading one back
 * spends N again. Resource population only adds one reference per distinct box, which covers 1024
 * bytes and no more, so a larger transfer must buy the budget explicitly by repeating the
 * reference — see {@link boxIoRefsPerCall} for spreading them once they outgrow a single call.
 */
export function boxIoRefsFor(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / BOX_IO_BYTES_PER_REF))
}

/**
 * Spread `refs` reference slots over as many app calls as it takes, most-loaded first.
 *
 * {@link MAX_APP_CALL_FOREIGN_REFERENCES} is the AVM's combined cap on accounts + apps + assets +
 * boxes for a single call, so a full three-page program (12 references' worth of write budget)
 * cannot be bought by one transaction; the surplus rides on companion calls to the same app. The
 * returned array is one entry per app call, the first being the call doing the work.
 *
 * @param refs Total reference slots the group must carry
 * @param label Method name, used for the group-limit error
 */
export function boxIoRefsPerCall(refs: number, label: string): number[] {
  const calls = Math.max(1, Math.ceil(refs / MAX_APP_CALL_FOREIGN_REFERENCES))
  if (calls > MAX_GROUP_SIZE) {
    throw new Error(
      `${label} needs ${refs} box references (${calls} app calls), over the ${MAX_GROUP_SIZE}-txn group limit.`,
    )
  }
  return Array.from({ length: calls }, (_, i) =>
    Math.min(MAX_APP_CALL_FOREIGN_REFERENCES, refs - i * MAX_APP_CALL_FOREIGN_REFERENCES),
  )
}
