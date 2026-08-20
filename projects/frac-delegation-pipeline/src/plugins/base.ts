import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { CommitteeMetadata } from 'ggov-sdk'
import type { FinalInstance } from '../types.ts'

/** Display name of a frac delegation instance, e.g. `Reti #12`. Matches the on-chain instance name. */
export type FracInstanceName = string

/** escrow address > instance name */
export type FracInstanceNameResultMap = Record<string, FracInstanceName>

/** address > AQ. Floored, uint32-bounded, and already filtered to accounts with at least 1 AQ. */
export type AQResultMap = Record<string, number>

/**
 * One source's AlgoQuarters run: the numbers, plus the manifest fields only that source can supply.
 * The pipeline adds what is not source-specific — the network genesis hash and the totals — when it
 * assembles the `AlgoQuartersFile` it uploads.
 */
export interface AQCalculation {
  /** Protocol identifier that goes on the manifest, e.g. `tinyman-consensus-staking`. */
  protocol: string
  /**
   * Liquid-token/ALGO rate used for the whole window (12-decimal fixed-point string).
   * Absent for natively staked sources, which have no such conversion.
   */
  rate?: string
  accounts: AQResultMap
}

/** The committee an AQ run is scoped to: which committee, and the round window it covers. */
export type AQCommittee = Pick<CommitteeMetadata, 'numericId' | 'periodStart' | 'periodEnd'>

/**
 * A staking source integrated into the pipeline. One plugin per source (reti, talgo, xalgo, ...):
 * it knows how to discover that source's escrows and how to split stake across its delegators.
 */
export abstract class FracPipelinePlugin {
  /** Source name, as used in the pipeline's `stakingSources`. Mirrors the class' static `source`. */
  public abstract readonly name: string

  protected readonly algorand: AlgorandClient
  protected readonly overrides?: Record<string, unknown>

  /**
   * plugin constructor, receives the algorand client and optional overrides for configuration
   * @param algorand
   * @param overrides
   */
  // NOTE: written out as explicit fields, not constructor parameter properties: scripts run on
  // node's strip-only TS mode, which rejects parameter properties at parse time.
  constructor(algorand: AlgorandClient, overrides?: Record<string, unknown>) {
    this.algorand = algorand
    this.overrides = overrides
  }

  /**
   * async initialization method for the plugin, can be used to set up any necessary state or connections
   */
  public abstract init(): Promise<void>

  /**
   * Resolve the instance names from the escrow addresses, returning a map of escrow address to instance name
   * @param escrowAddrs
   */
  public abstract getInstanceNameFromEscrowAddrs(escrowAddrs: string[]): Promise<FracInstanceNameResultMap>

  /**
   * Calculate AQ for every instance of this source that the committee implies.
   *
   * Called **once per source per committee**, not once per instance: a source that runs many
   * instances (reti, one per validator) scans the window once and slices the result, rather than
   * repeating the same scan per instance. Single-instance sources get a one-element array and
   * answer with a one-entry map.
   *
   * The result covers the source's *depositors* — the accounts whose stake the escrows pool — not
   * the committee's members, who are the escrows themselves. Which depositors land on which
   * instance is the plugin's own business: it holds the name-to-source-id convention it minted in
   * `getInstanceNameFromEscrowAddrs`, and `instance.escrowAddresses` names exactly the escrows of
   * that instance which are in this committee.
   *
   * @param committee the committee's numeric id and the round window `[periodStart, periodEnd)`
   * @param instances instances of this source still needing AQ for `committee`, never empty
   * @returns one calculation per instance, keyed by instance name. An instance left out of the map
   *   (or given an empty `accounts`) is reported as having no AQ support and is not uploaded.
   */
  public abstract calculateCommitteeAQ(
    committee: AQCommittee,
    instances: FinalInstance[],
  ): Promise<Map<FracInstanceName, AQCalculation>>
}

/**
 * Shape the registry loads plugins through: constructible from a client plus overrides, and carrying
 * its source name statically, so the registry can be keyed without instantiating anything.
 */
export type FracPipelinePluginConstructor = (new (
  algorand: AlgorandClient,
  overrides?: Record<string, unknown>,
) => FracPipelinePlugin) & { readonly source: string }
