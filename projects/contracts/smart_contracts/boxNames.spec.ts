import { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { ABIType, ABIValue, base64ToBytes } from 'algosdk'
import { describe, expect, test } from 'vitest'
import { FRAC_VOTING_RECORD_KEY_LENGTH } from '../../frac-delegation-sdk/src/constants'
import { instanceBoxName, periodBoxName as fracPeriodBoxName } from '../../frac-delegation-sdk/src/util/boxes'
import { asciiBoxName, periodBoxName, topicBodyBoxName } from '../../ggov-sdk/src/util/boxNames'
import {
  GGOV_VOTE_RECORD_KEY_LENGTH,
  voteRecordBoxMbr,
  voteRecordValueLength,
} from '../../ggov-sdk/src/util/voteRecordMbr'
import { APP_SPEC as FRAC_INSTANCE_SPEC } from './artifacts/frac-delegation/FracDelegationInstanceClient'
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
      ['l', 'topicLengths'],
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

// Same principle as the name pins above, applied to the vote-record box *size*: `voteRecordBoxMbr`
// hardcodes an ARC-4 layout, and nothing on the happy path fails if that layout drifts — an
// under-estimate just means the registry runs dry later, in production, at someone else's vote. So
// the expectation is rebuilt here from the compiled specs (prefix + keyType for the name, the
// struct's own field types for the value) and encoded by algosdk, never by the same arithmetic.
describe('vote-record box MBR matches the compiled ARC-56 specs', () => {
  /** ARC-4 tuple type for a spec struct, e.g. GGovVoteRecord -> `(bool,uint32[])`. */
  const structType = (spec: Arc56Contract, name: string): ABIType =>
    ABIType.from(`(${spec.structs[name].map((f) => f.type as string).join(',')})`)

  /** Name length of a BoxMap entry: the spec's base64 prefix plus the ARC-4 encoded key. */
  const mapKeyLength = (spec: Arc56Contract, map: string, key: ABIValue): number => {
    const { prefix, keyType } = spec.state.maps.box[map]
    return base64ToBytes(prefix!).length + ABIType.from(keyType).encode(key).length
  }

  /** A [topic][option] ballot with `topics` topics of `options` options each. */
  const ballot = (topics: number, options: number): number[] => Array.from({ length: topics }, () => options)

  /**
   * An all-zero record of that shape — only its encoded length matters here. `topicVotes` is flat:
   * every topic's options concatenated in topic order, the shape recovered from `topicLengths`.
   */
  const emptyRecord = (optionCounts: number[]): ABIValue => [
    false,
    Array.from({ length: optionCounts.reduce((a, b) => a + b, 0) }, () => 0),
  ]

  const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

  // 1x1 is the floor a ready period can reach; 22x4 is the shape VOTE.md sizes operator funding
  // against; 60x8 approaches the ballot width setReady's 1024-byte log ceiling still admits. Several
  // shapes rather than one because the flat encoding makes the length depend on the option total
  // alone: a formula that re-grew a per-topic term would still pass at a single shape.
  const SHAPES: [number, number][] = [
    [1, 1],
    [3, 2],
    [22, 4],
    [60, 8],
  ]

  test.each(SHAPES)('GGovPeriod voteRecords, %s topics x %s options', (topics, options) => {
    const optionCounts = ballot(topics, options)
    const keyLength = mapKeyLength(GGOV_PERIOD_SPEC, 'voteRecords', ZERO_ADDRESS)
    const encoded = structType(GGOV_PERIOD_SPEC, 'GGovVoteRecord').encode(emptyRecord(optionCounts))

    expect(keyLength).toBe(GGOV_VOTE_RECORD_KEY_LENGTH)
    expect(voteRecordValueLength(optionCounts)).toBe(encoded.length)
    expect(voteRecordBoxMbr(keyLength, optionCounts)).toBe(2_500n + 400n * BigInt(keyLength + encoded.length))
  })

  test.each(SHAPES)('FracDelegationInstance votingRecords, %s topics x %s options', (topics, options) => {
    const optionCounts = ballot(topics, options)
    const keyLength = mapKeyLength(FRAC_INSTANCE_SPEC, 'votingRecords', [0, 0])
    const encoded = structType(FRAC_INSTANCE_SPEC, 'FracVotingRecord').encode(emptyRecord(optionCounts))

    expect(keyLength).toBe(FRAC_VOTING_RECORD_KEY_LENGTH)
    expect(voteRecordValueLength(optionCounts)).toBe(encoded.length)
    expect(voteRecordBoxMbr(keyLength, optionCounts)).toBe(2_500n + 400n * BigInt(keyLength + encoded.length))
  })

  // The two records are the same ARC-4 shape and differ only in key width, which is the whole reason
  // voteRecordBoxMbr takes a key length instead of existing twice. If they ever diverge, the shared
  // helper is wrong for one of them and the assertions above stop being independent.
  test('both records are the same ARC-4 shape', () => {
    expect(structType(FRAC_INSTANCE_SPEC, 'FracVotingRecord').toString()).toBe(
      structType(GGOV_PERIOD_SPEC, 'GGovVoteRecord').toString(),
    )
    expect(GGOV_VOTE_RECORD_KEY_LENGTH - FRAC_VOTING_RECORD_KEY_LENGTH).toBe(24)
  })
})
