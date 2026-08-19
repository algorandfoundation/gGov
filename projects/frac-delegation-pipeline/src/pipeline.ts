import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import {
  ALGORAND_ZERO_ADDRESS_STRING,
  getApplicationAddress,
  mnemonicToSecretKey,
  type TransactionSigner,
} from 'algosdk'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovRegistrySDK, type GGovCommitteeFile } from 'ggov-sdk'
import pMap from 'p-map'
import { AVAILABLE_SOURCES, getPlugin, RETI_REGISTRY_APP_ID_MAINNET, TALGO_APP_ID_MAINNET } from './plugins/index.ts'

// owned by the plugins now, re-exported for the seeding scripts
export const RETI_REGISTRY_APP_ID = RETI_REGISTRY_APP_ID_MAINNET
export const TALGO_APP_ID = TALGO_APP_ID_MAINNET
export const TALGO_APP_ADDRESS = getApplicationAddress(TALGO_APP_ID).toString()

// each staking source is identified by an easy string and implemented by a plugin under ./plugins,
// which the pipeline loads from the registry - adding a source touches nothing in here

// TODO refactor types into standalone file / types.ts

/** Admin of the two registries, or the operator that ingests AQ. */
type PipelineAccount = { sender: string; signer: TransactionSigner }

interface FracPipelineArgs {
  /** Client for ggov-sdk and frac-delegation-sdk. */
  algorand: AlgorandClient
  /**
   * Client the staking source plugins discover with. Defaults to `algorand`. Two clients initially
   * because reti-ghost-sdk is ESM, and the other SDKs are CJS, so sharing one client fails the
   * composer's `instanceof` check (TODO: change in reti-ghost-sdk? leave like this?). Then, realized
   * it is very useful for testing: discovery can always read mainnet, while the contracts may live
   * elsewhere (localnet, testnet). Innocent as not providing collapses to a single client.
   */
  discoveryClient?: AlgorandClient
  fracRegistryAppId: number
  ggovRegistryAppId: number
  /** Staking sources to run, defaulting to every plugin in the registry. */
  stakingSources?: string[]
  /**
   * How many independent reads, and how many instances' escrow registrations, run at once. Defaults
   * to 4, matching the SDK readers. Turn it down for a rate-limited node.
   */
  concurrency?: number
  /** Admin of both registries. Falls back to ADMIN/ADMIN_MNEMONIC in the environment. */
  adminAccount?: PipelineAccount
  /** Operator that ingests AQ. Falls back to the admin account. */
  operatorAccount?: PipelineAccount
  /** Log step stats and every write to the console, and put the SDKs in debug mode. */
  debug?: boolean
}

/** A staking instance in this committee that must exist on the frac registry. */
interface FutureInstance {
  /** Staking source that recognized the escrows, i.e. the plugin's name. */
  source: string
  /** Instance name, which is also its on-chain identity. */
  name: string
  /** Escrows backing it, already narrowed to members of the committee being run. */
  escrowAddresses: string[]
}

/** An instance that exists on the frac registry, i.e. one with an app behind it. */
interface RegisteredInstance {
  numId: number
  appId: bigint
}

interface FinalInstance extends FutureInstance, RegisteredInstance {}

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

export class FracDelegationPipeline {
  /** Main Algorand client, used for writes. */
  private readonly algorand: AlgorandClient
  /** Secondary Algorand client, used by the source plugins. If not provided in constructor, defaults to the main client. */
  private readonly discoveryClient: AlgorandClient
  private readonly fracSdk: FracDelegationSDK
  private readonly ggovSdk: GGovRegistrySDK
  private readonly sources: string[]
  private readonly concurrency: number

  /** Held for stage 4: AQ ingestion is the operator's job, not the admin's. */
  private readonly operatorAccount?: PipelineAccount
  private readonly debug: boolean
  // Per-run state, cleared at the top of `run` and filled by the step that owns each part.
  /** Everything the instance upsert reads and writes. Public: it is the run's report. */
  upsertInstancesCtx: UpsertInstancesContext = emptyUpsertInstancesContext()
  /** Everything the gGov delegation upsert reads and writes. Public: it is the run's report. */
  upsertDelegationsCtx: UpsertDelegationsContext = emptyUpsertDelegationsContext()
  /**
   * Every instance this committee needs and its on-chain identity, by instance name: the ones that
   * were already registered plus the ones this run created. Complete once stage 1 is done, and what
   * stage 2 works from - it is the only cache that pairs escrows with the app that holds them.
   */
  private instances: Map<string, FinalInstance> = new Map()

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
    this.fracSdk = new FracDelegationSDK({
      algorand,
      registryAppId: fracRegistryAppId,
      writerAccount: adminAccount,
      debug,
    })
    this.ggovSdk = new GGovRegistrySDK({
      algorand,
      registryAppId: ggovRegistryAppId,
      writerAccount: adminAccount,
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
   * Run the pipeline for one committee:
   * 1. upsert the instances the committee's escrows imply, with their escrows, on the frac registry
   * 2. point every escrow's gGov delegation at the instance that holds it
   * 3. (pending) calculate each committee member's AQ, per instance
   * 4. (pending) ingest that AQ onto the instances
   * @param committeeId committee to run, which has to be on the gGov registry already
   */
  async run(committeeId: string) {
    const committee = await this.ggovSdk.getCommittee(committeeId)
    if (!committee) throw new Error(`Wrong committee ID: ${committeeId} is not on the gGov registry`)

    // a re-run must not see the previous run's state, and neither must a caller inspecting the
    // pipeline after the upsert throws part-way
    this.upsertInstancesCtx = { ...emptyUpsertInstancesContext(), committeeId, committee }
    this.upsertDelegationsCtx = emptyUpsertDelegationsContext()

    this.instances = await this.upsertInstances(committeeId, committee)
    await this.upsertGGovDelegations()
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
          await getPlugin(source, this.discoveryClient)
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
