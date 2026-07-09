/**
 * Tinyman consensus staking — mainnet constants.
 * https://github.com/tinymanorg/tinyman-consensus-staking
 */

import { createHash } from 'node:crypto'
import { getApplicationAddress } from 'algosdk'

// Protocol identifier, goes on algoquarters output files
export const PROTOCOL = 'tinyman-consensus-staking'

// tALGO liquid staking token
// Creation: https://mainnet-idx.4160.nodely.dev/v2/transactions/ONH2OB7BLLT2FTKNKZ77J7SGJJKVAXLQXSIDUEYUFIW26OEHNNSQ
export const TALGO_ASA_ID = 2537013734n
export const TALGO_APP_ID = 2537013674n
// The app created tALGO and holds its undistributed reserve.
export const TALGO_APP_ADDRESS = getApplicationAddress(TALGO_APP_ID).toString()
export const TALGO_RATE_UPDATE_SELECTOR = createHash('sha512-256').update('rate_update(uint64)').digest().subarray(0, 4)

// stALGO re-staking token — frozen ASA, clawback authority = app escrow (only the app can move it)
// Creation: https://mainnet-idx.4160.nodely.dev/v2/transactions/HYFWUAVGYKIM37CNJSYLAOCLWGEL2Y3ZYXECGRQM5YIGE5XVPS3A
export const STALGO_ASA_ID = 2537023208n
export const STALGO_APP_ID = 2537022861n
// The app created stALGO, holds its undistributed reserve, and escrows deposited tALGO.
export const STALGO_APP_ADDRESS = getApplicationAddress(STALGO_APP_ID).toString()

// tALGO/ALGO rate scaler (1e12); algo_amount = talgo_amount * rate / RATE_SCALER
// The tALGO contract stores the tALGO/ALGO rate as an integer scaled by 1e12 to preserve precision.
// Rate is initialized at 1_000_000_000_000 (1:1) and increases as consensus nodes accrue block rewards.
export const RATE_SCALER = 1_000_000_000_000n
