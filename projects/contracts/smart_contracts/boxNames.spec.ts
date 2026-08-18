import { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { ABIType, ABIValue, base64ToBytes } from 'algosdk'
import { describe, expect, test } from 'vitest'
import { instanceBoxName, periodBoxName as fracPeriodBoxName } from '../../frac-delegation-sdk/src/util/boxes'
import { asciiBoxName, periodBoxName, topicBodyBoxName } from '../../ggov-sdk/src/util/boxNames'
import { APP_SPEC as FRAC_REGISTRY_SPEC } from './artifacts/frac-delegation/FracDelegationRegistryClient'
import { APP_SPEC as GGOV_PERIOD_SPEC } from './artifacts/ggov-period/GGovPeriodClient'
import { APP_SPEC as GGOV_REGISTRY_SPEC } from './artifacts/ggov-registry/GGovRegistryClient'

// Plain `.spec.ts`: no contract code, no chain — just the SDKs' hardcoded box name bytes against the
// compiled ARC-56 specs. Helpers come from SDK source, not `dist`, so edits need no rebuild.
//
// Why derive here and nowhere else: a box reference is only a resource declaration. Name one the
// contract no longer touches and nothing fails — the ref goes unused and population adds the right box
// at simulate. Drift is invisible to any happy-path test, so the literal and its expectation must not
// share a source.

/** Hex rendering, so a mismatch reports `'6a0000' !== '690000'` instead of two Uint8Array dumps. */
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Expected name for a BoxMap entry: the spec's base64 prefix followed by the ARC-4 encoded key. */
const mapBoxName = (spec: Arc56Contract, map: string, key: ABIValue): Uint8Array => {
  const { prefix, keyType } = spec.state.maps.box[map]
  return new Uint8Array([...base64ToBytes(prefix!), ...ABIType.from(keyType).encode(key)])
}

/** Expected name for a single-key box: the spec carries the whole key, not a prefix. */
const keyBoxName = (spec: Arc56Contract, key: string): Uint8Array => base64ToBytes(spec.state.keys.box[key].key)

const UINT32_MAX = 4_294_967_295n
const UINT16_MAX = 65_535n

describe('box name helpers match the compiled ARC-56 specs', () => {
  describe('BoxMap name builders', () => {
    // Three ids rather than one: any id catches a wrong prefix or a wrong key width (both change
    // the name's length), but 0 and the type's max are byte-order palindromes — only 1 catches an
    // encoder that writes the key little-endian.
    test.each([0n, 1n, UINT32_MAX])('periodBoxName(%s) matches GGovRegistry `periods`', (periodId) => {
      expect(hex(periodBoxName(periodId))).toBe(hex(mapBoxName(GGOV_REGISTRY_SPEC, 'periods', periodId)))
    })

    // frac-delegation-sdk carries its own copy: it declares the same gGov registry box for the
    // `GGovPeriod.vote` nested inside a frac vote, and the two SDK packages share no code. Pinned
    // against the same spec so the copies cannot drift apart silently.
    test.each([0n, 1n, UINT32_MAX])("frac's periodBoxName(%s) matches GGovRegistry `periods`", (periodId) => {
      expect(hex(fracPeriodBoxName(periodId))).toBe(hex(mapBoxName(GGOV_REGISTRY_SPEC, 'periods', periodId)))
    })

    test.each([0n, 1n, UINT32_MAX])('topicBodyBoxName(%s) matches GGovPeriod `topicBodies`', (topicIndex) => {
      expect(hex(topicBodyBoxName(topicIndex))).toBe(hex(mapBoxName(GGOV_PERIOD_SPEC, 'topicBodies', topicIndex)))
    })

    // `instances` is keyed by uint16, not uint32. The width is the easy thing to get wrong when
    // copying periodBoxName, and it is exactly what this comparison pins.
    test.each([0n, 1n, UINT16_MAX])(
      'instanceBoxName(%s) matches FracDelegationRegistry `instances`',
      (instanceNumId) => {
        expect(hex(instanceBoxName(instanceNumId))).toBe(
          hex(mapBoxName(FRAC_REGISTRY_SPEC, 'instances', instanceNumId)),
        )
      },
    )
  })

  describe('single-key box names', () => {
    test.each([
      ['o', 'topicOptionsArr'],
      ['t', 'topicVotesArr'],
      ['P', 'periodBody'],
    ])('asciiBoxName(%s) matches GGovPeriod `%s`', (char, specKey) => {
      expect(hex(asciiBoxName(char))).toBe(hex(keyBoxName(GGOV_PERIOD_SPEC, specKey)))
    })

    // The period app's `periodBody` key is 'P' (0x50); the registry's `periodApprovalBox` key is
    // 'Pap' (0x50 0x61 0x70). Same leading byte, different apps, different boxes. asciiBoxName is
    // single-byte by construction, so pointing it at the registry would silently truncate.
    test("asciiBoxName cannot address the registry's `periodApprovalBox`", () => {
      const registryApprovalKey = keyBoxName(GGOV_REGISTRY_SPEC, 'periodApprovalBox')
      expect(registryApprovalKey.length).toBeGreaterThan(1)
      expect(hex(asciiBoxName('P'))).not.toBe(hex(registryApprovalKey))
    })
  })
})
