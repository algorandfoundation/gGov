/**
 * The instance types the pipeline works in, shared with the plugins.
 *
 * They live here rather than in `pipeline.ts` because `calculateCommitteeAQ` takes `FinalInstance[]`:
 * a plugin has to see the instances of its source that the committee implies. `plugins/base.ts` and
 * `pipeline.ts` both import from here, and neither imports the other.
 */

/** A staking instance in this committee that must exist on the frac registry. */
export interface FutureInstance {
  /** Staking source that recognized the escrows, i.e. the plugin's name. */
  source: string
  /** Instance name, which is also its on-chain identity. */
  name: string
  /** Escrows backing it, already narrowed to members of the committee being run. */
  escrowAddresses: string[]
}

/** An instance that exists on the frac registry, i.e. one with an app behind it. */
export interface RegisteredInstance {
  numId: number
  appId: bigint
}

/** An instance the committee needs, in its final state: what it is, and where it lives on chain. */
export interface FinalInstance extends FutureInstance, RegisteredInstance {}
