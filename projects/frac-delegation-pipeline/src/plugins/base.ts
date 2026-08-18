import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { CommitteeMetadata } from 'ggov-sdk'

/** Display name of a frac delegation instance, e.g. `Reti #12`. Matches the on-chain instance name. */
export type FracInstanceName = string

/** escrow address > instance name */
export type FracInstanceNameResultMap = Record<string, FracInstanceName>

/** address > AQ */
export type AQResultMap = Record<string, number>

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
   * Calculate AQ for a given committee and optional internal id, returning a map of address to AQ
   * @param committee
   * @param internalId source-specific instance id, e.g. a reti validator ID
   */
  public abstract calculateCommitteeAQ<T>(committee: AQCommittee, internalId?: T): Promise<AQResultMap>
}

/**
 * Shape the registry loads plugins through: constructible from a client plus overrides, and carrying
 * its source name statically, so the registry can be keyed without instantiating anything.
 */
export type FracPipelinePluginConstructor = (new (
  algorand: AlgorandClient,
  overrides?: Record<string, unknown>,
) => FracPipelinePlugin) & { readonly source: string }
