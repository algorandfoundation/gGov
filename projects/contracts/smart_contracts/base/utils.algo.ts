import { bytes, err, log, uint64 } from '@algorandfoundation/algorand-typescript'
import { Uint16, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'

export function u16(v: uint64) {
  return new Uint16(v)
}

export function u32(v: uint64) {
  return new Uint32(v)
}

// looks like I can't do this? needed e.g. in Registry.getCommitteeAccountOffsetHint
//
// export function fail(code: string): never {
// log(code)
// err()
// }

// export function ensure(cond: boolean, code: string) {
//   if (!cond) {
//     fail(code)
//   }
// }

// export function ensureExtra(cond: boolean, code: string, extra: bytes) {
//   if (!cond) {
//     log(extra)
//     fail(code)
//   }
// }

export function ensure(cond: boolean, code: string) {
  if (!cond) {
    log(code)
    err()
  }
}

export function ensureExtra(cond: boolean, code: string, extra: bytes) {
  if (!cond) {
    log(extra)
    log(code)
    err()
  }
}
