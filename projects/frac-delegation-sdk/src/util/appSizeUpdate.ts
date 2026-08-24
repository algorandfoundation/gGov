import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { SenderWithSigner } from '../types.js'

/* Verbatim copy of ggov-sdk/src/util/appSizeUpdate.ts — the two SDKs do not share runtime code. */

/**
 * Global schema / extra-page sizing for an app, as carried on an ApplicationUpdate under AVM v13.
 *
 * Any field left undefined keeps the app's current value, so a caller can grow one dimension
 * without having to restate the others. The local schema is fixed at creation and cannot appear
 * here.
 */
export type AppSizeParams = {
  globalUints?: number
  globalBytes?: number
  extraProgramPages?: number
}

export function hasAppSizeChange(size?: AppSizeParams): size is AppSizeParams {
  return (
    size !== undefined &&
    (size.globalUints !== undefined || size.globalBytes !== undefined || size.extraProgramPages !== undefined)
  )
}

/**
 * Resize an app's global schema and/or extra program pages via an ApplicationUpdate.
 *
 * AVM v13 made both mutable, but only through the update transaction's `numGlobalInts` /
 * `numGlobalByteSlices` / `extraPages` fields. algokit-utils cannot express that: `AppUpdateParams`
 * has no schema fields at all, and its composer zeroes them whenever `appId !== 0` — so this builds
 * the transaction with algosdk directly and sends it outside the composer.
 *
 * The programs are re-supplied verbatim from what is already on chain, so this changes size only.
 * To change size *and* code in one go, pass the new programs explicitly.
 *
 * MBR, measured on localnet against algod 5.0.0: on any *increase*, the sender becomes the app's
 * `sizeSponsor` and takes on the schema + extra-page MBR in full — not the delta. The creator keeps
 * only the flat 100_000 µAlgo per-app base. Growing an app from 2 uints/1 byte/0 pages to
 * 20/10/3 moved 1_370_000 µAlgo (20*28_500 + 10*50_000 + 3*100_000) onto the sender and released
 * 107_000 from the creator. A pure *decrease* moves neither MBR nor sponsorship. Make sure the
 * sender can carry that balance before calling.
 */
export async function sendAppSizeUpdate({
  algorand,
  appId,
  account,
  size,
  approvalProgram,
  clearStateProgram,
  appReferences,
  note,
}: {
  algorand: AlgorandClient
  appId: bigint
  account: SenderWithSigner
  size: AppSizeParams
  /** Defaults to the app's current on-chain approval program. */
  approvalProgram?: Uint8Array
  /** Defaults to the app's current on-chain clear-state program. */
  clearStateProgram?: Uint8Array
  /**
   * Apps the update call needs to read. Leaving the composer means losing its automatic resource
   * population, and the child apps resolve their admin by reading the registry's `admin` global —
   * which fails with "unavailable App N" unless the registry is referenced here.
   */
  appReferences?: (bigint | number)[]
  note?: string | Uint8Array
}): Promise<{ txId: string }> {
  const algod = algorand.client.algod
  const { params } = await algod.getApplicationByID(appId).do()
  if (!params) throw new Error(`App ${appId} not found`)
  const sender = typeof account.sender === 'string' ? algosdk.Address.fromString(account.sender) : account.sender

  const txn = algosdk.makeApplicationUpdateTxnFromObject({
    sender,
    appIndex: appId,
    approvalProgram: approvalProgram ?? params.approvalProgram,
    clearProgram: clearStateProgram ?? params.clearStateProgram,
    numGlobalInts: size.globalUints ?? Number(params.globalStateSchema?.numUint ?? 0),
    numGlobalByteSlices: size.globalBytes ?? Number(params.globalStateSchema?.numByteSlice ?? 0),
    extraPages: size.extraProgramPages ?? Number(params.extraProgramPages ?? 0),
    foreignApps: appReferences?.map((a) => BigInt(a)),
    note: typeof note === 'string' ? new TextEncoder().encode(note) : note,
    suggestedParams: await algod.getTransactionParams().do(),
  })

  const [signed] = await account.signer([txn], [0])
  const { txid } = await algod.sendRawTransaction(signed).do()
  await algosdk.waitForConfirmation(algod, txid, 5)
  return { txId: txid }
}
