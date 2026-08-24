/** Bytes of program an app gets per page; the first page is included in the base app. */
const PROGRAM_PAGE_BYTES = 2048

/**
 * Extra program pages an app needs to hold `approval` + `clear`.
 *
 * An app gets `(1 + extraProgramPages)` pages of {@link PROGRAM_PAGE_BYTES}, and AVM v13 raised the
 * ceiling from 3 extra pages (8KB) to 7 (16KB).
 *
 * algokit-utils has the same calculation internally, but does not expose it: `calculateExtraProgramPages`
 * lives at `@algorandfoundation/algokit-utils/util`, which is absent from the package's `exports`
 * map, so importing it typechecks and then fails at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
export function extraProgramPages(approval: Uint8Array, clear: Uint8Array = new Uint8Array()): number {
  const total = approval.length + clear.length
  if (total <= PROGRAM_PAGE_BYTES) return 0
  return Math.ceil(total / PROGRAM_PAGE_BYTES) - 1
}
