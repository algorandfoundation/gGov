/**
 * Folks Finance xALGO — mainnet constants.
 *
 * Consensus (liquid staking) app: https://github.com/Folks-Finance/algo-liquid-staking-contracts
 * Lending v2 (the xALGO pool and the escrow apps): https://github.com/Folks-Finance/folks-finance-js-sdk
 * Every id, address, selector and byte layout below was verified on mainnet on 2026-08-19 (see
 * README.md for the transactions used).
 */

import { createHash } from 'node:crypto'
import { getApplicationAddress } from 'algosdk'

/** Protocol identifier, goes on algoquarters output files. */
export const PROTOCOL = 'folks-xalgo'

/** xALGO is a single staking instance, so every escrow it exposes resolves to this one name. */
export const XALGO_INSTANCE_NAME = 'Folks xALGO'

// ---------------------------------------------------------------------------
// xALGO consensus app + ASA
// ---------------------------------------------------------------------------

/** The consensus app: mints/burns xALGO and stakes the pooled ALGO on its proposers (the escrows). */
export const XALGO_APP_ID_MAINNET = 1134695678n
export const XALGO_APP_CREATION_ROUND = 30058558n
/** Creator + reserve of xALGO: un-minted supply lives here and burns return here. */
export const XALGO_APP_ADDRESS = getApplicationAddress(XALGO_APP_ID_MAINNET).toString()

/** xALGO liquid staking token: total 1e16, 6 dp, no clawback/freeze. */
export const XALGO_ASA_ID = 1134696561n
export const XALGO_ASA_CREATION_ROUND = 30058590n

/** Each proposer (escrow) gets one box, keyed `ap` + its 32-byte public key. */
export const PROPOSER_BOX_PREFIX = new TextEncoder().encode('ap')
export const PROPOSER_BOX_NAME_LENGTH = PROPOSER_BOX_PREFIX.length + 32

/**
 * Folks "ultrastake" router (`StakeAndDeposit`): mints xALGO and deposits it into the lending pool
 * in one group. Holds nothing at rest; listed for recognition only.
 */
export const STAKE_AND_DEPOSIT_APP_ID = 2633147490n

// ---------------------------------------------------------------------------
// xALGO rate events (ARC-28 logs of the consensus app)
// ---------------------------------------------------------------------------

const selector = (signature: string) => createHash('sha512-256').update(signature).digest().subarray(0, 4)

/** 84 bytes: selector · sender(32) · receiver(32) · algo(u64) · xalgo(u64). Embeds `premium` (0 today). */
export const IMMEDIATE_MINT_SELECTOR = selector('ImmediateMint(address,address,uint64,uint64)') // 5af2d40e
export const IMMEDIATE_MINT_LOG_LENGTH = 4 + 32 + 32 + 8 + 8
/** 52 bytes: selector · sender(32) · xalgo(u64) · algo(u64). NOTE xALGO comes first. Exact rate. */
export const BURN_SELECTOR = selector('Burn(address,uint64,uint64)') // 45a62f7a
export const BURN_LOG_LENGTH = 4 + 32 + 8 + 8
/** 120 bytes: selector · box name(36) · minter(32) · receiver(32) · algo(u64) · xalgo(u64). Exact rate. */
export const CLAIM_DELAYED_MINT_SELECTOR = selector('ClaimDelayedMint(byte[36],address,address,uint64,uint64)') // 27017652
export const CLAIM_DELAYED_MINT_LOG_LENGTH = 4 + 36 + 32 + 32 + 8 + 8
/** `UpdatePremium(uint64)`: the only way the premium changes; scan once to confirm it was always 0. */
export const UPDATE_PREMIUM_SELECTOR = selector('UpdatePremium(uint64)') // 86219c29

/** xALGO/ALGO rate scaler (1e12): `algo_amount = xalgo_amount * rate / RATE_SCALER`. Same 12-dp manifest convention as tALGO. */
export const RATE_SCALER = 1_000_000_000_000n

// ---------------------------------------------------------------------------
// Folks Finance v2 lending: the xALGO pool and the escrow apps that hold its fxALGO
// ---------------------------------------------------------------------------

/** Folks v2 xALGO lending pool. Holds the deposited xALGO (~60% of circulating supply today). */
export const XALGO_POOL_APP_ID = 2611131944n
export const XALGO_POOL_APP_CREATION_ROUND = 45366638n
/** Creator + reserve of fxALGO, and the account the deposited xALGO physically sits in. */
export const XALGO_POOL_ADDRESS = getApplicationAddress(XALGO_POOL_APP_ID).toString()

/** fxALGO ("Folks V2 xALGO"): the pool's deposit receipt token. total 1e16, 6 dp, no clawback/freeze. */
export const FXALGO_ASA_ID = 2611138444n
export const FXALGO_ASA_CREATION_ROUND = 45366725n

/** Owner local-state key an escrow app writes for its escrows. */
export type EscrowOwnerKey = 'u' | 'ua'

/** A Folks app whose escrows (fresh accounts rekeyed to the app) can hold fxALGO for a user. */
export interface FolksEscrowApp {
  appId: bigint
  /** The app's account: escrows are rekeyed to it, and the creation note payment is sent to it. */
  address: string
  /** Creation-note prefix: `prefix + 32-byte escrow pubkey` on a pay from the owner to `address`. */
  notePrefix: Uint8Array
  /** Local-state key holding the owner address (32 bytes) while the escrow is open. */
  ownerKey: EscrowOwnerKey
  /** Round the app was created: nothing to resolve before it. */
  creationRound: bigint
  label: string
}

const escrowApp = (
  appId: bigint,
  notePrefix: string,
  ownerKey: EscrowOwnerKey,
  creationRound: bigint,
  label: string,
): FolksEscrowApp => ({
  appId,
  address: getApplicationAddress(appId).toString(),
  notePrefix: new TextEncoder().encode(notePrefix),
  ownerKey,
  creationRound,
  label,
})

/**
 * The Folks apps whose escrows hold fxALGO, i.e. the ones whose owners the attribution sees through
 * to. The two loan apps are the only ones that list the xALGO pool as collateral (Folks SDK
 * `MainnetPools.xALGO.loans`); the deposit apps hold fxALGO for plain depositors.
 *
 * Holder counts by `auth-addr` on 2026-08-19: ALGO_EFFICIENCY 2345, GENERAL 343, Deposits 645,
 * DepositStaking 0 (of 3352 fxALGO holders). `verify` warns when an fxALGO holder is rekeyed to an
 * app that is not in this list — that is how a new Folks escrow type shows up.
 */
export const FOLKS_ESCROW_APPS: readonly FolksEscrowApp[] = [
  // "ultrastake": stake ALGO, deposit the xALGO as collateral, borrow ALGO against it
  escrowApp(971389489n, 'la ', 'u', 25404033n, 'loan ALGO_EFFICIENCY'),
  escrowApp(971388781n, 'la ', 'u', 25404015n, 'loan GENERAL'),
  escrowApp(971353536n, 'da ', 'ua', 25403231n, 'deposits'),
  // no fxALGO holders today; kept because it is cheap and would otherwise be a silent gap
  escrowApp(1093729103n, 'fa ', 'ua', 28685103n, 'deposit staking'),
]

/**
 * Folks loan apps that do NOT list the xALGO pool as collateral today (Folks SDK `MainnetLoans`), so
 * their escrows should never hold fxALGO. If one does, Folks added the pool to that loan type and it
 * belongs in `FOLKS_ESCROW_APPS`: the resolver flags a holder rekeyed to any of these, even a single one.
 */
export const FOLKS_UNTRACKED_LOAN_APPS: ReadonlyMap<string, string> = new Map(
  (
    [
      [971388977n, 'loan STABLECOIN_EFFICIENCY'],
      [1202382736n, 'loan ULTRASWAP_UP'],
      [1202382829n, 'loan ULTRASWAP_DOWN'],
      [3184333108n, 'loan ALGORAND_ECOSYSTEM'],
    ] as const
  ).map(([appId, label]) => [getApplicationAddress(appId).toString(), `${label} (${appId})`]),
)

/** escrow app address > app, for recognizing a rekeyed escrow by its `auth-addr`. */
export const FOLKS_ESCROW_APP_BY_ADDRESS: ReadonlyMap<string, FolksEscrowApp> = new Map(
  FOLKS_ESCROW_APPS.map((app) => [app.address, app]),
)

/** escrow app id > app, for recognizing an escrow by the local state it holds. */
export const FOLKS_ESCROW_APP_BY_ID: ReadonlyMap<bigint, FolksEscrowApp> = new Map(
  FOLKS_ESCROW_APPS.map((app) => [app.appId, app]),
)

/** Creation note: 3-byte prefix + 32-byte escrow public key. */
export const ESCROW_NOTE_LENGTH = 3 + 32

// ---------------------------------------------------------------------------
// Attribution arithmetic
// ---------------------------------------------------------------------------

/**
 * Fixed-point scale of the pool index `R = ∫ poolXalgo / fxCirculating dt`. The ratio sits near 1, so
 * 18 decimals leave the per-step floor at < 1e-18 of a holder's fxALGO per round — see README.
 */
export const INDEX_SCALE = 10n ** 18n
