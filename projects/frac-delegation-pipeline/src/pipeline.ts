import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import {
  ALGORAND_ZERO_ADDRESS_STRING,
  getApplicationAddress,
  mnemonicToSecretKey,
  type TransactionSigner,
} from 'algosdk'
import { FracDelegationSDK, type AlgoQuartersFile, type FracCommitteeAq } from 'frac-delegation-sdk'
import { GGovRegistrySDK, type GGovCommitteeFile } from 'ggov-sdk'
import pMap from 'p-map'
import {
  AVAILABLE_SOURCES,
  getPlugin,
  RETI_REGISTRY_APP_ID_MAINNET,
  TALGO_APP_ID_MAINNET,
  type AQCalculation,
  type AQCommittee,
  type FracPipelinePlugin,
} from './plugins/index.ts'
import type { FinalInstance, FutureInstance, RegisteredInstance } from './types.ts'

// owned by the plugins now, re-exported for the seeding scripts
export const RETI_REGISTRY_APP_ID = RETI_REGISTRY_APP_ID_MAINNET
export const TALGO_APP_ID = TALGO_APP_ID_MAINNET
export const TALGO_APP_ADDRESS = getApplicationAddress(TALGO_APP_ID).toString()

// each staking source is identified by an easy string and implemented by a plugin under ./plugins,
// which the pipeline loads from the registry - adding a source touches nothing in here

/** Admin of the two registries, or the operator that ingests AQ. */
type PipelineAccount = { sender: string; signer: TransactionSigner }

interface FracPipelineArgs {
  /** Client for ggov-sdk and frac-delegation-sdk. */
  algorand: AlgorandClient
  /**
   * Client the staking source plugins discover with. Defaults to `algorand`. Kept separate because
   * it is very useful for testing: discovery can always read mainnet, while the contracts may live
   * elsewhere (localnet, testnet). Innocent as not providing collapses to a single client.
   */
  discoveryClient?: AlgorandClient
  fracRegistryAppId: number
  ggovRegistryAppId: number
  /** Staking sources to run, defaulting to every plugin in the registry. */
  stakingSources?: string[]
  /**
   * How many independent reads, and how many instances' escrow registrations, run at once — passed
   * through to the SDKs' own chunked readers and to the staking-source plugins, so it also bounds
   * the AlgoQuarters window scans and reti's per-validator box reads. Defaults to 4, matching the
   * SDK readers and `SCAN_CONCURRENCY`. Turn it down for a rate-limited node.
   *
   * It is a per-caller bound, not a global one: independent readers still overlap, so a full stage-3
   * run has several of these in flight at once (see `aq/config.ts`).
   */
  concurrency?: number
  /** Admin of both registries. Falls back to ADMIN/ADMIN_MNEMONIC in the environment. */
  adminAccount?: PipelineAccount
  /** Operator that ingests AQ. Falls back to the admin account. */
  operatorAccount?: PipelineAccount
  /** Log step stats and every write to the console, and put the SDKs in debug mode. */
  debug?: boolean
}

/**
 * Everything the instance upsert works from and produces, for the caller to log or assert on.
 * Empty until `run` has been called, and cleared at the top of every run.
 */
interface UpsertInstancesContext {
  /** Committee the run was scoped to. */
  committeeId?: string
  /** That committee as the gGov registry held it when the run started. */
  committee?: GGovCommitteeFile
  /** What the committee implies must exist, per staking source. The root everything else derives from. */
  futureInstances: FutureInstance[]
  /** Of those, the ones the frac registry already held when the run started, by instance name. */
  existingInstances: Map<string, RegisteredInstance>
  /** Of future instances, the ones with no app behind them yet: what this run creates. */
  instancesToCreate: FutureInstance[]
  /** Escrows of already-existing instances that this run registers to them. */
  existingInstanceEscrowsToRegister: PendingEscrowRegistration[]
  /** Instances this run created, by instance name. Empty until the create step runs. */
  instancesCreated: Map<string, RegisteredInstance>
  /** Escrows this run registered to instances that already existed on the frac registry. */
  existingInstanceNewEscrows: { instance: string; escrow: string }[]
  /** Instances this run created, with the escrows registered to them. */
  createdInstances: { instance: string; escrows: string[] }[]
}

/** An escrow of an already-registered instance that still has to be registered to it. */
interface PendingEscrowRegistration {
  instanceNumId: number
  instanceName: string
  escrowAddress: string
}

/** One instance's outstanding escrow registrations: the unit the register phase fans out over. */
interface EscrowRegistrationJob {
  instanceNumId: number
  instanceName: string
  escrowAddresses: string[]
  /** Whether this run created the instance, which is what decides where the job is reported. */
  isNew: boolean
  /** Set once every group of the job has landed. */
  registered: boolean
}

/** A committee escrow and the frac instance its gGov delegation has to point at. */
interface EscrowDelegation {
  escrowAddress: string
  instanceName: string
  /** Account of the instance's app: the delegatee `importFracDelegations` writes for this escrow. */
  instanceAppAddress: string
}

/**
 * Everything the gGov delegation upsert works from and produces, for the caller to log or assert on.
 * Empty until `run` has been called, and cleared at the top of every run.
 */
interface UpsertDelegationsContext {
  /** Every escrow of every instance, with the delegatee it must end up on. The root of this stage. */
  expectedDelegations: Map<string, EscrowDelegation>
  /** Escrows the gGov registry already delegates to their own instance: nothing to write. */
  alreadyDelegated: EscrowDelegation[]
  /** Escrows with no gGov delegation at all yet. */
  undelegated: EscrowDelegation[]
  /** Escrows delegated somewhere other than their own instance, which the import overwrites. */
  misdelegated: (EscrowDelegation & { currentDelegatee: string })[]
  /** The undelegated plus the misdelegated: what this run imports. */
  delegationsToImport: EscrowDelegation[]
  /** Delegations this run imported. Empty unless every group landed, as the import is all-or-nothing here. */
  delegationsImported: EscrowDelegation[]
}

/** One instance's AlgoQuarters outcome for the committee: what stage 3 did about it, and why. */
interface InstanceAqResult {
  instanceName: string
  instanceNumId: number
  source: string
  /** The committee's numeric id on the instance, once its snapshot exists. */
  committeeNumId?: number
  /** The instance's ledger as stage 3 left it. Absent when nothing was uploaded. */
  committeeAq?: FracCommitteeAq
  /** Accounts and total AQ the plugin computed. Absent when the ledger was already complete. */
  calculated?: { totalAccounts: number; totalAlgoQuarters: string }
}

/** One instance's computed AlgoQuarters, waiting its turn in the serial ingest phase. */
interface PendingIngest {
  instance: FinalInstance
  /** The instance's entry in the run report, filled in with the ledger once the ingest lands. */
  result: InstanceAqResult
  aqFile: AlgoQuartersFile
}

/**
 * What one source's compute phase produced: its instances sorted into the outcomes that need no
 * write, plus the ones that do. Returned rather than pushed onto the run context, because the
 * compute phase runs concurrently across sources and the report has to read the same on every run —
 * the caller merges these in source order.
 */
interface SourceAqComputation {
  alreadyComplete: InstanceAqResult[]
  skippedNoAqSupport: InstanceAqResult[]
  noEligibleAccounts: InstanceAqResult[]
  pendingIngest: PendingIngest[]
}

/**
 * Everything the AlgoQuarters upsert works from and produces, for the caller to log or assert on.
 * Empty until `run` has been called, and cleared at the top of every run.
 */
interface UpsertAqContext {
  /** The committee's on-chain metadata: the numeric id and the round window AQ is computed over. */
  committee?: AQCommittee
  /** Instances whose ledger was already complete when the run started: nothing computed, nothing written. */
  alreadyComplete: InstanceAqResult[]
  /** Instances whose source has no AQ implementation yet, so there was nothing to upload. */
  skippedNoAqSupport: InstanceAqResult[]
  /**
   * Instances whose source computed AQ for them and found no eligible account. Routine for a
   * multi-instance source — a reti validator whose committee pools held no stake over the window
   * earns nobody anything — and nothing to upload, since a manifest with no accounts is invalid.
   *
   * Such an instance never opens a ledger, so it stays pending and its source is re-computed on
   * every run. Unavoidable without a way to record "computed, nobody qualified" on chain: whether
   * an instance has eligible accounts is only knowable by scanning the window.
   */
  noEligibleAccounts: InstanceAqResult[]
  /** Instances this run computed AQ for and ingested. */
  uploaded: InstanceAqResult[]
}

export class FracDelegationPipeline {
  /** Main Algorand client, used for writes. */
  private readonly algorand: AlgorandClient
  /** Secondary Algorand client, used by the source plugins. If not provided in constructor, defaults to the main client. */
  private readonly discoveryClient: AlgorandClient
  private readonly fracSdk: FracDelegationSDK
  /**
   * The same frac registry, signed for by the operator. `syncCommittee`, `startAqIngest` and
   * `ingestAq` are all operator-only, while every registry write stage 1 makes is admin-only, so
   * the two roles get a client each rather than one client that swaps its writer mid-run.
   */
  private readonly fracOperatorSdk: FracDelegationSDK
  private readonly ggovSdk: GGovRegistrySDK
  private readonly sources: string[]
  private readonly concurrency: number

  /** AQ ingestion is the operator's job, not the admin's: this is what `fracOperatorSdk` signs with. */
  private readonly operatorAccount?: PipelineAccount
  private readonly debug: boolean
  // Per-run state, cleared at the top of `run` and filled by the step that owns each part.
  /** Everything the instance upsert reads and writes. Public: it is the run's report. */
  upsertInstancesCtx: UpsertInstancesContext = emptyUpsertInstancesContext()
  /** Everything the gGov delegation upsert reads and writes. Public: it is the run's report. */
  upsertDelegationsCtx: UpsertDelegationsContext = emptyUpsertDelegationsContext()
  /** Everything the AlgoQuarters upsert reads and writes. Public: it is the run's report. */
  upsertAqCtx: UpsertAqContext = emptyUpsertAqContext()
  /**
   * Every instance this committee needs and its on-chain identity, by instance name: the ones that
   * were already registered plus the ones this run created. Complete once stage 1 is done, and what
   * stage 2 works from - it is the only cache that pairs escrows with the app that holds them.
   */
  private instances: Map<string, FinalInstance> = new Map()
  /**
   * Plugins built for this run, by source — as promises, so concurrent callers share one build
   * rather than racing to make two. Cleared at the top of every run.
   */
  private pluginsBySource: Map<string, Promise<FracPipelinePlugin>> = new Map()

  constructor({
    algorand,
    discoveryClient,
    fracRegistryAppId,
    ggovRegistryAppId,
    stakingSources,
    concurrency = 4,
    adminAccount,
    operatorAccount,
    debug = false,
  }: FracPipelineArgs) {
    this.algorand = algorand
    this.discoveryClient = discoveryClient ?? algorand
    this.concurrency = concurrency
    this.debug = debug
    adminAccount = adminAccount ?? envAccount(algorand)
    this.operatorAccount = operatorAccount ?? adminAccount
    // `concurrency` goes to the SDKs too: their chunked readers each default to 4 of their own, so
    // without this the pipeline's knob would only move half of what it names.
    this.fracSdk = new FracDelegationSDK({
      algorand,
      registryAppId: fracRegistryAppId,
      writerAccount: adminAccount,
      concurrency,
      debug,
    })
    this.fracOperatorSdk = new FracDelegationSDK({
      algorand,
      registryAppId: fracRegistryAppId,
      writerAccount: this.operatorAccount,
      concurrency,
      debug,
    })
    this.ggovSdk = new GGovRegistrySDK({
      algorand,
      registryAppId: ggovRegistryAppId,
      writerAccount: adminAccount,
      concurrency,
      debug,
    })
    if (stakingSources && stakingSources.length !== new Set(stakingSources).size) {
      throw new Error('Duplicate staking sources are not allowed')
    }
    this.sources = stakingSources ?? AVAILABLE_SOURCES
  }

  /** Step stats and one line per write, on the console. Silent unless the pipeline is in debug mode. */
  private log(message: string) {
    if (this.debug) console.log(`[pipeline] ${message}`)
  }

  /**
   * Run `work` and log how long it took, so a slow run can be attributed to a stage rather than
   * guessed at. Logged even when `work` throws — where the time went is most interesting then.
   */
  private async timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      return await work()
    } finally {
      this.log(`⏱ ${label}: ${elapsed(started)}`)
    }
  }

  /**
   * The plugin for a staking source, built at most once per run. Stage 1 and stage 3 both need it,
   * and building one is not free — reti resolves every validator's pools to answer either call — so
   * the second caller reuses the first's instance and whatever that instance has cached. It also
   * guarantees both stages see the *same* live registry read, which is what reti's escrow-to-pool
   * mapping already assumes.
   *
   * Lazy on purpose: a source whose instances are all complete must never construct its plugin, so
   * that a re-run stays free.
   */
  private getSourcePlugin(source: string): Promise<FracPipelinePlugin> {
    let plugin = this.pluginsBySource.get(source)
    if (!plugin) {
      // The promise is cached, not the resolved plugin, so two concurrent callers share one build.
      // A rejected build is cached too, which is harmless: a source that cannot be built throws the
      // run either way.
      // `concurrency` goes to the plugin too: the window scans and box reads it owns are the
      // pipeline's widest fan-out, so a caller turning this down for a rate-limited indexer has to
      // reach them as well as the SDK readers.
      plugin = getPlugin(source, this.discoveryClient, undefined, this.concurrency)
      this.pluginsBySource.set(source, plugin)
    }
    return plugin
  }

  /**
   * Run the pipeline for one committee:
   * 1. upsert the instances the committee's escrows imply, with their escrows, on the frac registry
   * 2. point every escrow's gGov delegation at the instance that holds it
   * 3. for every instance whose AQ ledger for this committee is not already complete, calculate its
   *    source's AlgoQuarters and ingest them
   * @param committeeId committee to run, which has to be on the gGov registry already
   */
  async run(committeeId: string) {
    const committee = await this.ggovSdk.getCommittee(committeeId)
    if (!committee) throw new Error(`Wrong committee ID: ${committeeId} is not on the gGov registry`)

    // a re-run must not see the previous run's state, and neither must a caller inspecting the
    // pipeline after the upsert throws part-way
    this.upsertInstancesCtx = { ...emptyUpsertInstancesContext(), committeeId, committee }
    this.upsertDelegationsCtx = emptyUpsertDelegationsContext()
    this.upsertAqCtx = emptyUpsertAqContext()
    this.pluginsBySource = new Map()

    const started = Date.now()
    this.instances = await this.timed('stage 1 (instance upsert)', () => this.upsertInstances(committeeId, committee))
    await this.timed('stage 2 (gGov delegations)', () => this.upsertGGovDelegations())
    await this.timed('stage 3 (AlgoQuarters)', () => this.upsertCommitteeAq(committeeId))
    this.log(`⏱ run total: ${elapsed(started)}`)
  }

  /**
   * Recognize the committee's escrows, reconcile the instances behind them against the frac registry
   * and write the difference: escrows missing from instances that are already registered, and the
   * instances that do not exist yet, with all of their escrows.
   * @returns every instance the committee needs, in its final state, by instance name
   */
  private async upsertInstances(committeeId: string, committee: GGovCommitteeFile) {
    const ctx = this.upsertInstancesCtx
    const allInstances = new Map<string, FinalInstance>()

    // Stage 1: escrow/instance recognition + on-chain reconciliation

    // escrow recognition: every gov in the committee goes past every source, and the ones a source
    // claims are its escrows. Sources only ever see committee members, so an escrow outside the
    // committee cannot enter the analysis in the first place
    const committeeGovAddresses = committee.govs.map((gov) => gov.address)
    this.log(`committee ${committeeId}: ${committeeGovAddresses.length} govs, sources: ${this.sources.join(', ')}`)
    // discovery is read-only, so the sources fan out. The merge below stays serial, in `this.sources` order: it is what raises the claim conflicts, and
    // those have to name the same two sources on every run.
    const discovered = await pMap(
      this.sources,
      async (source) => ({
        source,
        // an unknown source throws out of the registry
        instanceNameByEscrow: await (
          await this.getSourcePlugin(source)
        ).getInstanceNameFromEscrowAddrs(committeeGovAddresses),
      }),
      { concurrency: this.concurrency },
    )
    const sourceByEscrow = new Map<string, string>()
    for (const { source, instanceNameByEscrow } of discovered) {
      const recognized = Object.entries(instanceNameByEscrow)
      this.log(
        `${source}: ${recognized.length} of the committee's govs are escrows, in ${new Set(Object.values(instanceNameByEscrow)).size} instances`,
      )
      for (const [escrowAddress, instanceName] of recognized) {
        // escrows cannot be repeated across sources
        const claimedBy = sourceByEscrow.get(escrowAddress)
        if (claimedBy) throw new Error(`Escrow ${escrowAddress} claimed by both ${claimedBy} and ${source}`)
        sourceByEscrow.set(escrowAddress, source)
        const known = this.upsertInstancesCtx.futureInstances.find((i) => i.name === instanceName)
        // the instance name is its on-chain identity, so two sources cannot answer with the same one
        if (known && known.source !== source) {
          throw new Error(`Instance ${instanceName} claimed by both ${known.source} and ${source}`)
        }
        if (known) known.escrowAddresses.push(escrowAddress)
        else
          this.upsertInstancesCtx.futureInstances.push({ source, name: instanceName, escrowAddresses: [escrowAddress] })
      }
    }
    this.log(`recognized ${sourceByEscrow.size} escrows in ${this.upsertInstancesCtx.futureInstances.length} instances`)
    if (this.debug) {
      const escrowsBySource = new Map<string, number>()
      for (const [_, source] of sourceByEscrow.entries()) {
        escrowsBySource.set(source, (escrowsBySource.get(source) || 0) + 1)
      }
      for (const [source, count] of escrowsBySource.entries()) {
        this.log(`${source}: ${count} escrow(s) recognized`)
      }
    }

    // get the current data from the contracts
    const onChainInstances = await this.fracSdk.registry.getExistingInstances()
    for (const [numId, instance] of onChainInstances.entries()) {
      if (!ctx.futureInstances.some((i) => i.name === instance.name)) {
        // if the instance is on-chain but not in the fetched data, it may be a stale instance
        // what should we do here? for now, log and continue
        console.warn(
          `instance ${instance.name} (appId ${instance.appId}) is on-chain but not in committee ${committeeId} data, ignoring`,
        )
        continue
      }
      ctx.existingInstances.set(instance.name, { numId, appId: instance.appId })
    }

    // instances not on chain, need to be created
    ctx.instancesToCreate = ctx.futureInstances.filter((i) => !ctx.existingInstances.has(i.name))
    this.log(
      `${ctx.existingInstances.size} of them already on the frac registry, ${ctx.instancesToCreate.length} to create`,
    )

    // for the instances that do exist, are all their escrows registered?
    // the escrows of new instances are skipped as they will be registered when the instance is created
    const existingPairs = ctx.futureInstances.flatMap((future) => {
      const onChain = ctx.existingInstances.get(future.name)
      return onChain ? [{ future, onChain }] : []
    })
    // one readonly simulate per instance, each against its own app: independent, so they fan out
    const escrowsOnChain = await pMap(
      existingPairs,
      async ({ onChain }) => new Set(await this.fracSdk.getEscrows(onChain.numId)),
      { concurrency: this.concurrency },
    )
    for (const [i, { future, onChain }] of existingPairs.entries()) {
      // already registered, so this one is final as it stands - the rest join as this run creates them
      allInstances.set(future.name, { ...future, ...onChain })
      for (const escrowAddress of future.escrowAddresses) {
        if (escrowsOnChain[i].has(escrowAddress)) continue
        ctx.existingInstanceEscrowsToRegister.push({
          instanceNumId: onChain.numId,
          instanceName: future.name,
          escrowAddress,
        })
      }
    }

    // WRITE: create the new instances, one at a time. Sequential on purpose - do NOT pMap these.
    // createInstance names the box it writes after the incremented `lastInstanceNumId`, and
    // resource population predicts that name from the pre-state, so concurrent creates would all
    // reference the same box and every one but the first to commit would fail with an invalid box
    // reference. Their escrows are registered in the phase below, once every instance exists.
    this.log(
      `creating ${ctx.instancesToCreate.length} instances with ${ctx.instancesToCreate.reduce((n, i) => n + i.escrowAddresses.length, 0)} escrows`,
    )
    for (const newInstance of ctx.instancesToCreate) {
      // 1 ALG0 for MBR
      const instanceNumId = await this.fracSdk.registry.addInstance({ name: newInstance.name, mbrAmount: 1e6 })
      const appId = await this.fracSdk.getInstanceAppId(instanceNumId)
      ctx.instancesCreated.set(newInstance.name, { numId: Number(instanceNumId), appId })
      allInstances.set(newInstance.name, { ...newInstance, numId: Number(instanceNumId), appId })
      this.log(`WRITE addInstance: ${newInstance.name} (#${instanceNumId}, appId ${appId})`)
    }

    // WRITE: register every escrow this run owes - to the instances that already existed and to the
    // ones just created - as one job per instance.
    const jobs = this.escrowRegistrationJobs()
    this.log(
      `registering ${jobs.reduce((n, j) => n + j.escrowAddresses.length, 0)} escrows across ${jobs.length} instances`,
    )
    try {
      // Two instances share no mutable state: the escrow -> instance box is keyed by the escrow, and
      // the registry's instances box and the instance app's own escrows list are per instance. So
      // the jobs fan out, while the calls within one job stay in ordered, atomic groups -
      // registerEscrowsAll - because they all read and rewrite that one growing escrows box.
      await pMap(
        jobs,
        async (job) => {
          if (job.escrowAddresses.length === 0) return
          await this.fracSdk.registry.registerEscrowsAll({
            instanceNumId: job.instanceNumId,
            accounts: job.escrowAddresses,
          })
          job.registered = true
          this.log(
            `WRITE registerEscrows(${job.isNew ? 'new' : 'existing'}): ${job.escrowAddresses.length} escrows -> ${job.instanceName} (#${job.instanceNumId})`,
          )
        },
        { concurrency: this.concurrency },
      )
    } finally {
      // Report in job order whatever landed, so the context still shows the run's progress when a
      // job throws. A job is all-or-nothing here even though it may span several groups: an
      // instance whose registration failed part-way reports nothing, and re-running picks up the
      // remainder (an already-assigned escrow is rejected, not registered twice).
      for (const job of jobs) {
        if (!job.registered) continue
        if (job.isNew) ctx.createdInstances.push({ instance: job.instanceName, escrows: job.escrowAddresses })
        else
          for (const escrow of job.escrowAddresses)
            ctx.existingInstanceNewEscrows.push({ instance: job.instanceName, escrow })
      }
    }
    this.log(
      `[STAGE 1] instance upsert done: ${allInstances.size} instances hold ${[...allInstances.values()].reduce((n, i) => n + i.escrowAddresses.length, 0)} committee escrows`,
    )
    return allInstances
  }

  /**
   * The escrow registrations stage 1 still owes, one job per instance: the escrows missing from the
   * instances that were already on the registry, plus every escrow of the instances this run has
   * just created. Grouping by instance is what makes the writes safe to fan out.
   */
  private escrowRegistrationJobs(): EscrowRegistrationJob[] {
    const ctx = this.upsertInstancesCtx
    const byInstance = new Map<number, EscrowRegistrationJob>()
    for (const { instanceNumId, instanceName, escrowAddress } of ctx.existingInstanceEscrowsToRegister) {
      let job = byInstance.get(instanceNumId)
      if (!job) {
        job = { instanceNumId, instanceName, escrowAddresses: [], isNew: false, registered: false }
        byInstance.set(instanceNumId, job)
      }
      job.escrowAddresses.push(escrowAddress)
    }
    for (const newInstance of ctx.instancesToCreate) {
      // invariant: the create phase awaits every addInstance and throws out of the run on failure,
      // so getting here means every instance to create was created. Assert rather than skip - a
      // skipped instance would silently never have its escrows registered, and the run would still
      // report success.
      const created = ctx.instancesCreated.get(newInstance.name)
      if (!created) throw new Error(`Instance ${newInstance.name} was not created, cannot register its escrows`)
      byInstance.set(created.numId, {
        instanceNumId: created.numId,
        instanceName: newInstance.name,
        escrowAddresses: newInstance.escrowAddresses,
        isNew: true,
        registered: false,
      })
    }
    return [...byInstance.values()]
  }

  /**
   * Stage 2: make the gGov registry delegate every committee escrow to the frac instance that holds
   * it, so the instance can cast that escrow's pooled votes.
   *
   * Works off `this.instances`, so stage 1 has to have finished: an escrow can only be delegated to
   * an instance app that exists on chain and already has the escrow registered to it.
   */
  private async upsertGGovDelegations() {
    const ctx = this.upsertDelegationsCtx

    // a correct delegation points at the account of the escrow's instance app, which is what the
    // registry's `importFracDelegations` resolves (through the frac registry) and writes
    for (const instance of this.instances.values()) {
      const instanceAppAddress = getApplicationAddress(instance.appId).toString()
      for (const escrowAddress of instance.escrowAddresses) {
        ctx.expectedDelegations.set(escrowAddress, { escrowAddress, instanceName: instance.name, instanceAppAddress })
      }
    }
    const escrowAddresses = [...ctx.expectedDelegations.keys()]
    this.log(`checking gGov delegations of ${escrowAddresses.length} escrows across ${this.instances.size} instances`)
    if (escrowAddresses.length === 0) return

    // one batched read for the lot: the SDK chunks it and answers in the order asked, with the zero
    // address standing in for an escrow that has never delegated
    const currentDelegatees = await this.ggovSdk.getDelegations(escrowAddresses)
    for (const [i, escrowAddress] of escrowAddresses.entries()) {
      const expected = ctx.expectedDelegations.get(escrowAddress)!
      const currentDelegatee = currentDelegatees[i]
      if (currentDelegatee === expected.instanceAppAddress) {
        ctx.alreadyDelegated.push(expected)
      } else if (currentDelegatee === ALGORAND_ZERO_ADDRESS_STRING) {
        ctx.undelegated.push(expected)
      } else {
        // a gov may have delegated wherever they liked before entering the pool; the import
        // overwrites that, which is the point of pooled staking, but it is worth seeing
        ctx.misdelegated.push({ ...expected, currentDelegatee })
        console.warn(
          `escrow ${escrowAddress} of ${expected.instanceName} is delegated to ${currentDelegatee}, redirecting it to the instance`,
        )
      }
    }
    ctx.delegationsToImport = [...ctx.undelegated, ...ctx.misdelegated]
    this.log(
      `${ctx.alreadyDelegated.length} already delegated to their instance, ${ctx.undelegated.length} undelegated, ` +
        `${ctx.misdelegated.length} delegated elsewhere: importing ${ctx.delegationsToImport.length}`,
    )
    if (ctx.delegationsToImport.length === 0) return

    // WRITE: import the delegations, which the SDK sends one transaction group per
    // MAX_ESCROWS_PER_FD_IMPORT escrows.
    this.log(`WRITE importFracDelegations: ${ctx.delegationsToImport.length} escrows`)
    await this.ggovSdk.importFracDelegationsAll({
      escrowAccounts: ctx.delegationsToImport.map(({ escrowAddress }) => escrowAddress),
    })
    ctx.delegationsImported = ctx.delegationsToImport
    this.log(
      `[STAGE 2] gGov registry delegation upsert done: ${ctx.alreadyDelegated.length + ctx.delegationsImported.length} of ${escrowAddresses.length} escrows delegated to their instance`,
    )
  }

  /**
   * Stage 3: give every instance the AlgoQuarters its source's depositors earned over the
   * committee's window, so their pooled votes can be split by weight.
   *
   * Works off `this.instances`, so stage 1 has to have finished. Grouped by source, not by
   * instance: each source's ledgers are read first and only the instances still needing AQ are
   * carried forward, so a source whose instances are all complete is skipped before its plugin is
   * even constructed — which is what makes a re-run free. The pending instances then go to the
   * source's plugin in one call, and it decides how to split the window it scans among them.
   *
   * Two phases, because reading and writing have opposite concurrency rules:
   *
   * - **Compute** — ledger reads, the Indexer window scan and the replay. Minutes per source and
   *   entirely independent between sources, so the sources run concurrently and the longest scan
   *   (xALGO) covers the others instead of being added to them.
   * - **Ingest** — strictly serial, across sources as well as instances. `uploadAqFile` is a long
   *   run of sequential groups whose box names derive from account ids the frac *registry* hands
   *   out as it goes. That counter is registry-wide, so two instances ingesting at once predict the
   *   same next ids and all but the first to commit fail with an invalid box reference — exactly the
   *   reason the SDK refuses to parallelize the batches within one upload.
   */
  private async upsertCommitteeAq(committeeId: string) {
    const ctx = this.upsertAqCtx

    // the AQ window is the committee's own, and `numericId` is the `committeeNumId` every instance
    // keys its ledger by. One read for the whole stage.
    const metadata = await this.ggovSdk.getCommitteeMetadata(committeeId)
    if (!metadata) throw new Error(`Committee ${committeeId} has no metadata on the gGov registry`)
    const committee: AQCommittee = {
      numericId: metadata.numericId,
      periodStart: metadata.periodStart,
      periodEnd: metadata.periodEnd,
    }
    ctx.committee = committee
    this.log(
      `AQ for committee ${committeeId} (#${metadata.numericId}), rounds ` +
        `[${metadata.periodStart}, ${metadata.periodEnd}) across ${this.instances.size} instances`,
    )

    // instances by source, in the order stage 1 produced them, so logs and claim conflicts read
    // the same way on every run
    const instancesBySource = new Map<string, FinalInstance[]>()
    for (const instance of this.instances.values()) {
      const forSource = instancesBySource.get(instance.source)
      if (forSource) forSource.push(instance)
      else instancesBySource.set(instance.source, [instance])
    }
    if (instancesBySource.size === 0) return

    // The genesis hash stamped on every manifest is the *write* network's and cannot change during
    // a run, so it is read once here rather than once per instance down in `buildAqFile`.
    const networkGenesisHash = await this.networkGenesisHash()

    // PHASE 1 - compute, concurrent across sources. Reads and CPU only: nothing here writes.
    const computations = await pMap(
      [...instancesBySource.entries()],
      ([source, instances]) =>
        this.timed(`stage 3 compute (${source})`, () =>
          this.computeSourceAq(source, instances, committee, committeeId, networkGenesisHash),
        ),
      { concurrency: this.concurrency },
    )

    // pMap answers in input order, so merging here restores the per-source ordering the concurrent
    // phase could not keep - the run report reads identically on every run.
    const pendingIngest: PendingIngest[] = []
    for (const computation of computations) {
      ctx.alreadyComplete.push(...computation.alreadyComplete)
      ctx.skippedNoAqSupport.push(...computation.skippedNoAqSupport)
      ctx.noEligibleAccounts.push(...computation.noEligibleAccounts)
      pendingIngest.push(...computation.pendingIngest)
    }

    // PHASE 2 - ingest, strictly serial. See the note above: do NOT pMap this loop.
    if (pendingIngest.length > 0) {
      await this.timed(`stage 3 ingest (${pendingIngest.length} instances)`, async () => {
        for (const { instance, result, aqFile } of pendingIngest) {
          const { committeeNumId, committeeAq } = await this.uploadAQ(instance.numId, committeeId, aqFile)
          result.committeeNumId = committeeNumId
          result.committeeAq = committeeAq
          ctx.uploaded.push(result)
        }
      })
    }

    this.log(
      `[STAGE 3] AQ upsert done: ${ctx.uploaded.length} instances ingested, ` +
        `${ctx.alreadyComplete.length} already complete, ${ctx.noEligibleAccounts.length} with no eligible ` +
        `accounts, ${ctx.skippedNoAqSupport.length} without AQ support`,
    )
  }

  /**
   * The compute half of stage 3 for one source: read its instances' ledgers, scan and replay the
   * committee's window for the ones still pending, and assemble a manifest per instance.
   *
   * Writes nothing and touches no shared state, which is what lets the sources run concurrently.
   */
  private async computeSourceAq(
    source: string,
    instances: FinalInstance[],
    committee: AQCommittee,
    committeeId: string,
    networkGenesisHash: string,
  ): Promise<SourceAqComputation> {
    const computation: SourceAqComputation = {
      alreadyComplete: [],
      skippedNoAqSupport: [],
      noEligibleAccounts: [],
      pendingIngest: [],
    }

    // Ledgers first: an instance whose ledger is already complete needs no computation, and a
    // source with no incomplete instance left needs no plugin and no Indexer scan at all.
    // Independent read-only lookups, so they fan out - a multi-instance source (reti runs one per
    // validator) would otherwise spend a serial round trip per instance before any scan starts.
    const ledgers = await this.timed(`stage 3 precheck (${source}, ${instances.length} instances)`, () =>
      pMap(instances, (instance) => this.getCommitteeAqLedger(instance.numId, committeeId), {
        concurrency: this.concurrency,
      }),
    )

    const pending: FinalInstance[] = []
    const resultByInstance = new Map<string, InstanceAqResult>()
    for (const [i, instance] of instances.entries()) {
      const result: InstanceAqResult = {
        instanceName: instance.name,
        instanceNumId: instance.numId,
        source: instance.source,
      }
      resultByInstance.set(instance.name, result)

      const ledger = ledgers[i]
      if (ledger) {
        result.committeeNumId = ledger.committeeNumId
        result.committeeAq = ledger.committeeAq
        // The contract's own rule, from getCommitteeAq(mustBeComplete): both counters have to land.
        if (
          Number(ledger.committeeAq.ingestedAq) === Number(ledger.committeeAq.totalAq) &&
          Number(ledger.committeeAq.numAccounts) === Number(ledger.committeeAq.totalAccounts)
        ) {
          this.log(
            `${instance.name}: ledger already complete (${ledger.committeeAq.ingestedAq} AQ, ` +
              `${ledger.committeeAq.numAccounts} accounts), skipping`,
          )
          computation.alreadyComplete.push(result)
          continue
        }
      }
      pending.push(instance)
    }

    if (pending.length === 0) {
      this.log(`${source}: every instance's ledger is already complete, nothing to compute`)
      return computation
    }

    // One call, one window scan, however many instances the source has in this committee
    this.log(`${source}: computing AQ for ${pending.length} instance(s): ${pending.map((i) => i.name).join(', ')}`)
    const plugin = await this.getSourcePlugin(source)
    const calculations = await plugin.calculateCommitteeAQ(committee, pending)

    for (const instance of pending) {
      const result = resultByInstance.get(instance.name)!
      // A source whose plugin has no AQ implementation yet leaves the instance out of the map.
      // Uploading nothing would fail manifest validation, so it is reported and left for when the
      // plugin lands.
      const calculation = calculations.get(instance.name)
      if (!calculation) {
        console.warn(
          `no AlgoQuarters computed for ${instance.name}: source ${source} has no AQ implementation yet, skipping`,
        )
        computation.skippedNoAqSupport.push(result)
        continue
      }
      // Computed, and nobody qualified. Not an error: an instance whose committee pools held no
      // stake over the window has nothing to distribute, and a manifest with no accounts is
      // invalid, so there is nothing to write either.
      if (Object.keys(calculation.accounts).length === 0) {
        this.log(`${instance.name}: no account earned a whole AlgoQuarter over the window, nothing to ingest`)
        computation.noEligibleAccounts.push(result)
        continue
      }

      const aqFile = buildAqFile(calculation, committee, networkGenesisHash)
      result.calculated = { totalAccounts: aqFile.totalAccounts, totalAlgoQuarters: aqFile.totalAlgoQuarters }
      this.log(
        `${instance.name}: computed ${aqFile.totalAccounts} accounts, ${aqFile.totalAlgoQuarters} AQ` +
          `${aqFile.rate ? ` at rate ${aqFile.rate}` : ''}`,
      )
      computation.pendingIngest.push({ instance, result, aqFile })
    }

    return computation
  }

  /**
   * Genesis hash of the network the contracts live on, base64 as the manifest carries it.
   *
   * From the WRITE client, not the discovery client: `uploadAqFile` checks the manifest against the
   * network being written to. Those differ by design - a localnet run computes its AQ from mainnet
   * history and ingests it onto localnet.
   */
  private async networkGenesisHash(): Promise<string> {
    const suggestedParams = await this.algorand.getSuggestedParams()
    return Buffer.from(suggestedParams.genesisHash!).toString('base64')
  }

  /**
   * An instance's AQ ledger for a committee, or undefined when there is nothing to read yet — the
   * instance has never synced the committee, or has synced it but never opened a ledger.
   */
  private async getCommitteeAqLedger(instanceNumId: number, committeeId: string) {
    const committee = await this.fracOperatorSdk.getCommittee(instanceNumId, committeeId)
    if (!committee) return undefined
    const committeeNumId = Number(committee.committeeNumId)
    const committeeAq = await this.fracOperatorSdk.getCommitteeAq(instanceNumId, committeeNumId)
    return committeeAq ? { committeeNumId, committeeAq } : undefined
  }

  /**
   * WRITE: ingest one instance's AQ manifest, as the operator.
   *
   * The SDK owns the whole sequence: it validates the manifest, syncs the committee onto the
   * instance if it has no snapshot yet, opens the ledger with `startAqIngest`, ingests in batches
   * and asserts the ledger is complete at the end. It is resumable, so a run interrupted part-way
   * finishes on the next one rather than double-counting.
   *
   * `autoFund` because both app accounts pay box MBR per ingested account and there is no funding
   * path between them: the operator tops up the shortfall rather than the run stopping on it.
   */
  private async uploadAQ(instanceNumId: number, committeeId: string, aqFile: AlgoQuartersFile) {
    this.log(`WRITE uploadAqFile: instance #${instanceNumId}, ${aqFile.totalAccounts} accounts`)
    return this.fracOperatorSdk.uploadAqFile({ instanceNumId, committeeId, aqFile, autoFund: true })
  }
}

/**
 * Assemble the AQ manifest `uploadAqFile` takes from what the plugin computed. The plugin owns the
 * source-specific fields (`protocol`, `rate`); the rest is the same for every source.
 *
 * Pure: `networkGenesisHash` is read once per run by the caller rather than per instance here.
 */
function buildAqFile(calculation: AQCalculation, committee: AQCommittee, networkGenesisHash: string): AlgoQuartersFile {
  // Codepoint order (not locale-dependent), matching the committee-file convention
  const accounts = Object.entries(calculation.accounts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, aq]) => ({ account, algoQuarters: aq.toString() }))
  const totalAlgoQuarters = accounts.reduce((sum, { algoQuarters }) => sum + BigInt(algoQuarters), 0n)

  return {
    networkGenesisHash,
    protocol: calculation.protocol,
    periodStart: committee.periodStart,
    periodEnd: committee.periodEnd,
    ...(calculation.rate === undefined ? {} : { rate: calculation.rate }),
    totalAccounts: accounts.length,
    totalAlgoQuarters: totalAlgoQuarters.toString(),
    accounts,
  }
}

/** How long since `started`, as a short human-readable duration. */
function elapsed(started: number): string {
  const seconds = (Date.now() - started) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}s`
}

/**
 * The environment's admin account, registered on `algorand` so the SDKs can sign with it.
 * @returns undefined when ADMIN/ADMIN_MNEMONIC are not both set
 */
function envAccount(algorand: AlgorandClient): PipelineAccount | undefined {
  if (!process.env.ADMIN_MNEMONIC || !process.env.ADMIN) return undefined
  algorand.account.setSignerFromAccount(mnemonicToSecretKey(process.env.ADMIN_MNEMONIC))
  return { sender: process.env.ADMIN, signer: algorand.account.getSigner(process.env.ADMIN) }
}

/** A blank delegation context, so `upsertDelegationsCtx` is readable (and empty) before the first run. */
function emptyUpsertDelegationsContext(): UpsertDelegationsContext {
  return {
    expectedDelegations: new Map(),
    alreadyDelegated: [],
    undelegated: [],
    misdelegated: [],
    delegationsToImport: [],
    delegationsImported: [],
  }
}

/** A blank AQ context, so `upsertAqCtx` is readable (and empty) before the first run. */
function emptyUpsertAqContext(): UpsertAqContext {
  return { alreadyComplete: [], skippedNoAqSupport: [], noEligibleAccounts: [], uploaded: [] }
}

/** A blank upsert context, so `upsertInstancesCtx` is readable (and empty) before the first run. */
function emptyUpsertInstancesContext(): UpsertInstancesContext {
  return {
    futureInstances: [],
    existingInstances: new Map(),
    instancesToCreate: [],
    existingInstanceEscrowsToRegister: [],
    instancesCreated: new Map(),
    existingInstanceNewEscrows: [],
    createdInstances: [],
  }
}
