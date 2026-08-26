import { uint64 } from '@algorandfoundation/algorand-typescript'
import { Uint16, Uint32, Uint8 } from '@algorandfoundation/algorand-typescript/arc4'

export function u8(v: uint64) {
  return new Uint8(v)
}

export function u16(v: uint64) {
  return new Uint16(v)
}

export function u32(v: uint64) {
  return new Uint32(v)
}
