import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getApplicationAddress, encodeAddress, mnemonicToSecretKey } from 'algosdk'
import { FracDelegationSDK } from 'frac-delegation-sdk'
import { GGovRegistrySDK } from 'ggov-sdk'
import { RetiGhostSDK } from 'reti-ghost-sdk'

export const RETI_REGISTRY_APP_ID = 2714516089
export const TALGO_APP_ID = 2537013674n
export const TALGO_APP_ADDRESS = getApplicationAddress(TALGO_APP_ID).toString()

// each staking sources is identified by an easy string
// pipeline-integrated sources are defined in this constant for now
// TODO: add xalgo once implemented
const STAKING_SOURCES = ['reti', 'talgo']

interface FracPipelineArgs {
  /** Client for ggov-sdk and frac-delegation-sdk. */
  algorand: AlgorandClient
  /**
   * Client for staking source discovery. Defaults to `algorand`. Two clients initially because
   * reti-ghost-sdk is ESM, and the other SDKs are CJS, so sharing one client fails the composer's
   * `instanceof` check (TODO: change in reti-ghost-sdk? leave like this?). Then, realized it is
   * very useful for testing: discovery can always read mainnet, while the contracts may live
   * elsewhere (localnet, testnet). Innocent as not providing collapses to a single client.
   */
  algorand2?: AlgorandClient
  fracRegistryAppId: number
  ggovRegistryAppId: number
  stakingSources?: string[]
  debugSdk?: boolean
}

interface Instance {
  source: string
  name: string
  appId?: bigint
  numId?: number
  escrowAddresses: string[]
}

interface RetiValidatorWithPools {
  validatorId: number
  pools: {
    poolAppId: bigint
    totalStakers: number
    totalAlgoStaked: bigint
    poolAppEscrow: string
  }[]
}

export class FracDelegationPipeline {
  /** Main Algorand client, used for writes. */
  private readonly algorand: AlgorandClient
  /** Secondary Algorand client, used for Reti SDK and discovery. If not provided in constructor, defaults to the main client. */
  private readonly algorand2: AlgorandClient
  private readonly fracSdk: FracDelegationSDK
  private readonly ggovSdk: GGovRegistrySDK
  private readonly retiSdk: RetiGhostSDK
  private readonly sources: string[]
  // cache data
  private instancesCache: Instance[] = []
  private retiCache: RetiValidatorWithPools[] = []
  ctx: { [key: string]: any } = {}

  constructor({
    algorand,
    algorand2,
    fracRegistryAppId,
    ggovRegistryAppId,
    stakingSources,
    debugSdk = false,
  }: FracPipelineArgs) {
    this.algorand = algorand
    this.algorand2 = algorand2 ?? algorand
    // TODO: how to handle the different privileges for the frac and gov SDKs? for now, admin for both registries
    // and operator are the same. how will this be for separate credentials? the pipeline needs admin rights on both
    // registries and operator rights for AQ ingestion.
    let adminAccount: { sender: string; signer: ReturnType<AlgorandClient['account']['getSigner']> } | undefined
    if (process.env.ADMIN_MNEMONIC && process.env.ADMIN) {
      algorand.account.setSignerFromAccount(mnemonicToSecretKey(process.env.ADMIN_MNEMONIC))
      adminAccount = { sender: process.env.ADMIN, signer: algorand.account.getSigner(process.env.ADMIN) }
    }
    this.fracSdk = new FracDelegationSDK({
      algorand,
      registryAppId: fracRegistryAppId,
      writerAccount: adminAccount,
      debug: debugSdk,
    })
    this.ggovSdk = new GGovRegistrySDK({
      algorand,
      registryAppId: ggovRegistryAppId,
      writerAccount: adminAccount,
      debug: debugSdk,
    })
    this.retiSdk = new RetiGhostSDK({ algorand: this.algorand2, registryAppId: RETI_REGISTRY_APP_ID })

    if (stakingSources && stakingSources.length !== new Set(stakingSources).size) {
      throw new Error('Duplicate staking sources are not allowed')
    }
    this.sources = stakingSources ?? STAKING_SOURCES
  }

  getInstancesCache() {
    return this.instancesCache
  }

  getRetiCache() {
    return this.retiCache
  }

  async run(committeeId: string) {
    const committee = await this.ggovSdk.getCommittee(committeeId)
    if (!committee) throw new Error(`Wrong committee ID: ${committeeId} is not on the gGov registry`)

    // discovery appends to the caches, so a re-run must start from empty
    this.instancesCache = []
    this.retiCache = []
    this.ctx = {
      committeeId: committee,
      instancesWithNoEscrows: [],
      instancesWithExcludedEscrows: [],
      registeredEscrows: [],
      createdInstances: [],
    }

    // Stage 1: escrow/instance recognition + on-chain reconciliation

    // each of them makes a discovery of the instances and its escrows, and writes cache
    for (const s of this.sources) {
      if ('reti' === s) {
        // get all validators and their pools
        const numValidators = await this.retiSdk.getNumValidators()
        const validatorIds = new Array(numValidators).fill(0).map((_, i) => i + 1)
        const poolsWithValidatorId = (await this.retiSdk.getPools(validatorIds)).map((pools, i) => ({
          validatorId: validatorIds[i],
          pools: pools.map((p) => ({
            poolAppEscrow: getApplicationAddress(p.poolAppId).toString(),
            ...p,
          })),
        }))
        // cache fetched data for later use
        poolsWithValidatorId.forEach(({ validatorId, pools }) => {
          this.retiCache.push({ validatorId, pools })
          this.instancesCache.push({
            source: 'reti',
            name: `Reti #${validatorId}`,
            escrowAddresses: pools.map((p) => p.poolAppEscrow),
          })
        })
      } else if ('talgo' === s) {
        // get accounts stored in the tALGO app global state
        const state = await this.algorand2.app.getGlobalState(TALGO_APP_ID)
        const escrows = Object.entries(state)
          .filter(([key]) => key.startsWith('account_'))
          // stable escrow order across runs - sort in slot order, so escrow indices track account_N
          .sort(([a], [b]) => Number(a.slice('account_'.length)) - Number(b.slice('account_'.length)))
          // narrow to byte-typed entries and filter out empty slots which would otherwise decode to the zero address
          .flatMap(([, v]) =>
            'valueRaw' in v && v.valueRaw.some((byte) => byte !== 0) ? [encodeAddress(v.valueRaw)] : [],
          )
        // account_0 is the app itself and is always set, so an empty result means the wrong app id
        if (!escrows.length) throw new Error(`talgo: app ${TALGO_APP_ID} exposes no account_* globals`)
        if (escrows[0] !== TALGO_APP_ADDRESS) throw new Error(`talgo: account_0 must be the app address`)
        this.instancesCache.push({
          source: 'talgo',
          name: 'Tinyman tALGO',
          escrowAddresses: escrows,
        })
      } else if ('xalgo' === s) {
        // TODO: implement
        throw new Error(`xalgo staking source not implemented yet`)
      } else {
        throw new Error(`Unknown staking source: ${s}`)
      }
    }

    // escrow recognition: intersection of committee escrows and fetched escrows
    const escrowsFetched = this.instancesCache.flatMap((i) => i.escrowAddresses)
    const escrowsFetchedSet = new Set(escrowsFetched)
    // escrows cannot be repeated across sources
    if (escrowsFetchedSet.size !== escrowsFetched.length) throw new Error('Repeated escrows found across sources')
    const escrowsInCommittee = new Set(
      committee.govs.map((gov) => gov.address).filter((addr) => escrowsFetchedSet.has(addr)),
    )

    // get the current data from the contracts
    const onChainInstances = await this.fracSdk.registry.getExistingInstances()
    for (const [numId, instance] of onChainInstances.entries()) {
      const matching = this.instancesCache.find((i) => i.name === instance.name)
      if (matching) {
        matching.appId = instance.appId
        matching.numId = numId
      } else {
        // if the instance is on-chain but not in the fetched data, it may be a stale instance
        // what should we do here? for now, log and continue
        console.warn(`instance ${instance.name} (appId ${instance.appId}) is on-chain but not has not fetched data`)
      }
    }

    // mutate the instance cache:
    // 1. only keep escrow addresses that are in the committee and report the rest as excluded from the pipeline analysis
    // 2. remove instances that have no escrows in the committee
    for (const instance of this.instancesCache) {
      const excluded: string[] = []
      instance.escrowAddresses = instance.escrowAddresses.filter((e) => {
        const isGov = escrowsInCommittee.has(e)
        if (!isGov) excluded.push(e)
        return isGov
      })
      if (instance.escrowAddresses.length === 0) {
        // from the ones fetched, the ones which have no escrows at all in the committee
        this.ctx.instancesWithNoEscrows.push(instance.name)
      }
      if (excluded.length > 0) {
        // instances with some fetched escrows not in the committee (partially excluded)
        this.ctx.instancesWithExcludedEscrows.push({ [instance.name]: excluded })
      }
    }
    this.instancesCache = this.instancesCache.filter((i) => i.escrowAddresses.length > 0)

    // for the created instances, are all their escrows registered? do not include the escrows that are
    // from a non-yet-created instance, as they will be registered when the instance is created
    const escrowsToRegister: string[] = []
    for (const i of this.instancesCache.filter((i) => i.numId !== undefined)) {
      const onChainEscrows = new Set(await this.fracSdk.getEscrows(i.numId!))
      const unregistered = i.escrowAddresses.filter((e) => !onChainEscrows.has(e))
      if (unregistered.length) escrowsToRegister.push(...unregistered)
    }

    // WRITE: register escrows for existing instances
    for (const e of escrowsToRegister) {
      const instance = this.instancesCache.find((i) => i.escrowAddresses.includes(e))
      // safety check: if the escrow is in the list to register, it must belong to an existing instance
      if (instance?.numId === undefined) throw new Error(`cannot find instance for escrow ${e}`)
      await this.fracSdk.registry.registerEscrow({ instanceNumId: instance.numId, account: e })
      this.ctx.registeredEscrows.push({ instance: instance.name, escrow: e })
    }

    // cached instances with no app ID need to be created by admin
    const instancesToCreate = this.instancesCache.filter((i) => i.appId === undefined)

    // WRITE: create new instances and register escrows
    for (const i of instancesToCreate) {
      // 1 ALG0 for MBR
      const instanceNumId = await this.fracSdk.registry.addInstance({ name: i.name, mbrAmount: 1e6 })
      // update instance cache with on-chain data
      i.numId = Number(instanceNumId)
      i.appId = await this.fracSdk.getInstanceAppId(instanceNumId)
      // register all escrows for the new instance
      for (const e of i.escrowAddresses) {
        await this.fracSdk.registry.registerEscrow({ instanceNumId, account: e })
      }
      this.ctx.createdInstances.push({ instance: i.name, escrows: i.escrowAddresses })
    }

    // WRITE: import frac delegations from just-registered escrows
    const escrowsToImportDelegations = escrowsToRegister.concat(instancesToCreate.flatMap((i) => i.escrowAddresses))
    await this.ggovSdk.importFracDelegationsAll({ escrowAccounts: escrowsToImportDelegations })

    // Stage 2: calculate staking share per user and create AQ files per instance
    // TODO: implement

    // Stage 3: upload AQ files (ingestion) - operator
    // TODO: implement
  }
}
