import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getApplicationAddress, mnemonicToSecretKey, TransactionSigner } from 'algosdk'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovRegistrySDK, type GGovCommitteeFile } from 'ggov-sdk'
import { AVAILABLE_SOURCES, getPlugin, RETI_REGISTRY_APP_ID_MAINNET, TALGO_APP_ID_MAINNET } from './plugins/index.ts'

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

/** What a run did, for the caller to log or assert on. Empty until `run` has been called. */
interface PipelineRunContext {
  /** Committee the run was scoped to. */
  committeeId?: string
  /** That committee as the gGov registry held it when the run started. */
  committee?: GGovCommitteeFile
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

export class FracDelegationPipeline {
  /** Main Algorand client, used for writes. */
  private readonly algorand: AlgorandClient
  /** Secondary Algorand client, used by the source plugins. If not provided in constructor, defaults to the main client. */
  private readonly discoveryClient: AlgorandClient
  private readonly fracSdk: FracDelegationSDK
  private readonly ggovSdk: GGovRegistrySDK
  private readonly sources: string[]

  /** Held for stage 3: AQ ingestion is the operator's job, not the admin's. */
  private readonly operatorAccount?: PipelineAccount
  private readonly debug: boolean
  // Per-run caches, cleared at the top of `run` and filled by the step that owns each one.
  /** What the committee implies must exist, per staking source. The root every other cache derives from. */
  private futureInstances: FutureInstance[] = []
  /** Of those, the ones the frac registry already held when the run started, by instance name. */
  private existingInstances: Map<string, RegisteredInstance> = new Map()
  /** Of those, the ones with no app behind them yet: what this run creates. */
  private instancesToCreate: FutureInstance[] = []
  /** Escrows of already-registered instances that this run registers to them. */
  private existingInstanceEscrowsToRegister: PendingEscrowRegistration[] = []
  /** Instances this run created, by instance name. Empty until the create step runs. */
  private instancesCreated: Map<string, RegisteredInstance> = new Map()
  ctx: PipelineRunContext = { existingInstanceNewEscrows: [], createdInstances: [] }

  constructor({
    algorand,
    discoveryClient,
    fracRegistryAppId,
    ggovRegistryAppId,
    stakingSources,
    adminAccount,
    operatorAccount,
    debug = false,
  }: FracPipelineArgs) {
    this.algorand = algorand
    this.discoveryClient = discoveryClient ?? algorand
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
   *
   * @param committeeId
   */
  async run(committeeId: string) {
    const committee = await this.ggovSdk.getCommittee(committeeId)
    if (!committee) throw new Error(`Wrong committee ID: ${committeeId} is not on the gGov registry`)

    /** new + existing instances that will exist by the end */
    this.futureInstances = []
    /** instances that existed on-chain at the start of the run */
    this.existingInstances = new Map()

    this.instancesToCreate = []
    this.existingInstanceEscrowsToRegister = []
    this.instancesCreated = new Map()
    this.ctx = {
      committeeId,
      committee,
      existingInstanceNewEscrows: [],
      createdInstances: [],
    }

    // Stage 1: escrow/instance recognition + on-chain reconciliation

    // escrow recognition: every gov in the committee goes past every source, and the ones a source
    // claims are its escrows. Sources only ever see committee members, so an escrow outside the
    // committee cannot enter the analysis in the first place
    const committeeGovAddresses = committee.govs.map((gov) => gov.address)
    this.log(`committee ${committeeId}: ${committeeGovAddresses.length} govs, sources: ${this.sources.join(', ')}`)
    const sourceByEscrow = new Map<string, string>()
    for (const source of this.sources) {
      // an unknown source throws out of the registry
      const plugin = await getPlugin(source, this.discoveryClient)
      const instanceNameByEscrow = await plugin.getInstanceNameFromEscrowAddrs(committeeGovAddresses)
      const recognized = Object.entries(instanceNameByEscrow)
      this.log(
        `${source}: ${recognized.length} of the committee's govs are escrows, in ${new Set(Object.values(instanceNameByEscrow)).size} instances`,
      )
      for (const [escrowAddress, instanceName] of recognized) {
        // escrows cannot be repeated across sources
        const claimedBy = sourceByEscrow.get(escrowAddress)
        if (claimedBy) throw new Error(`Escrow ${escrowAddress} claimed by both ${claimedBy} and ${source}`)
        sourceByEscrow.set(escrowAddress, source)
        const known = this.futureInstances.find((i) => i.name === instanceName)
        // the instance name is its on-chain identity, so two sources cannot answer with the same one
        if (known && known.source !== source) {
          throw new Error(`Instance ${instanceName} claimed by both ${known.source} and ${source}`)
        }
        if (known) known.escrowAddresses.push(escrowAddress)
        else this.futureInstances.push({ source, name: instanceName, escrowAddresses: [escrowAddress] })
      }
    }
    this.log(`recognized ${sourceByEscrow.size} escrows in ${this.futureInstances.length} instances`)
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
      if (!this.futureInstances.some((i) => i.name === instance.name)) {
        // if the instance is on-chain but not in the fetched data, it may be a stale instance
        // what should we do here? for now, log and continue
        console.warn(
          `instance ${instance.name} (appId ${instance.appId}) is on-chain but not in committee ${committeeId} data, ignoring`,
        )
        continue
      }
      this.existingInstances.set(instance.name, { numId, appId: instance.appId })
    }

    // instances not on chain, need to be created
    this.instancesToCreate = this.futureInstances.filter((i) => !this.existingInstances.has(i.name))
    this.log(
      `${this.existingInstances.size} of them already on the frac registry, ${this.instancesToCreate.length} to create`,
    )

    // for the instances that do exist, are all their escrows registered?
    // the escrows of new instances are skipped as they will be registered when the instance is created
    for (const future of this.futureInstances) {
      const onChain = this.existingInstances.get(future.name)
      if (!onChain) continue
      const onChainEscrows = new Set(await this.fracSdk.getEscrows(onChain.numId))
      for (const escrowAddress of future.escrowAddresses) {
        if (onChainEscrows.has(escrowAddress)) continue
        this.existingInstanceEscrowsToRegister.push({
          instanceNumId: onChain.numId,
          instanceName: future.name,
          escrowAddress,
        })
      }
    }

    // WRITE: register escrows for existing instances
    this.log(`registering ${this.existingInstanceEscrowsToRegister.length} escrows to existing instances`)
    for (const { instanceNumId, instanceName, escrowAddress } of this.existingInstanceEscrowsToRegister) {
      await this.fracSdk.registry.registerEscrow({ instanceNumId, account: escrowAddress })
      this.ctx.existingInstanceNewEscrows.push({ instance: instanceName, escrow: escrowAddress })
      this.log(`WRITE registerEscrow(existing): ${escrowAddress} -> ${instanceName} (#${instanceNumId})`)
    }

    // WRITE: create new instances and register escrows
    this.log(
      `creating ${this.instancesToCreate.length} instances with ${this.instancesToCreate.reduce((n, i) => n + i.escrowAddresses.length, 0)} escrows`,
    )
    for (const newInstance of this.instancesToCreate) {
      // 1 ALG0 for MBR
      const instanceNumId = await this.fracSdk.registry.addInstance({ name: newInstance.name, mbrAmount: 1e6 })
      const appId = await this.fracSdk.getInstanceAppId(instanceNumId)
      this.instancesCreated.set(newInstance.name, { numId: Number(instanceNumId), appId })
      this.log(`WRITE addInstance: ${newInstance.name} (#${instanceNumId}, appId ${appId})`)
      // register all escrows for the new instance
      for (const escrowAddress of newInstance.escrowAddresses) {
        await this.fracSdk.registry.registerEscrow({ instanceNumId, account: escrowAddress })
        this.log(`WRITE registerEscrow(new): ${escrowAddress} -> ${newInstance.name} (#${instanceNumId})`)
      }
      this.ctx.createdInstances.push({ instance: newInstance.name, escrows: newInstance.escrowAddresses })
    }
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
