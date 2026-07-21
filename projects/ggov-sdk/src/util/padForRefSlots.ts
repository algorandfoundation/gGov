/** Verbatim copy of frac-delegation-sdk/src/util/padForRefSlots.ts */
import { MAX_APP_CALL_FOREIGN_REFERENCES } from '@algorandfoundation/algokit-utils'
import { MAX_GROUP_SIZE } from '../constants'
import { noteNonce } from './noteNonce'

/**
 * Pad `builder` with no-op `increaseBudget` calls until the group carries `refSlots` reference
 * slots. Foreign/box references are capped at {@link MAX_APP_CALL_FOREIGN_REFERENCES} per app call
 * (the AVM's `MaxAppTotalTxnReferences`: accounts + apps + assets + boxes, combined), so a method
 * touching more than that needs company in the group or resource population fails with
 * "No more transactions below reference limit".
 *
 * `increaseBudget` is unauthenticated and does nothing at `itxns: 0`, so a pad costs one min fee
 * and buys 700 opcodes as a bonus. The pads must be app calls to the app that owns the boxes:
 * resource population only parks a box ref on a transaction that already has that app available,
 * and calls to the app itself do.
 *
 * Do not rely on `getIncreaseBudgetBuilder` for this. It prepends an increaseBudget only when the
 * group is over its *opcode* budget, which has masked reference shortfalls by accident — see the
 * TODO in `util/increaseBudget.ts`. Sizing the padding explicitly keeps callers working if that
 * heuristic ever stops firing.
 *
 * @param builder Group builder for the app that owns the boxes, with the padded call not yet added
 * @param refSlots Total reference slots the group must carry
 * @param label Method name, used for the error and to tag the pads' notes
 */
export function padForRefSlots<T extends { increaseBudget(args: unknown): T }>(
  builder: T,
  refSlots: number,
  label: string,
): T {
  const appCalls = Math.ceil(refSlots / MAX_APP_CALL_FOREIGN_REFERENCES)
  if (appCalls > MAX_GROUP_SIZE) {
    throw new Error(
      `${label} needs ${refSlots} reference slots (${appCalls} app calls), over the ${MAX_GROUP_SIZE}-txn group limit.`,
    )
  }
  for (let i = 1; i < appCalls; i++) {
    // Distinct notes: otherwise identical pads would collide into one duplicate txn ID.
    builder = builder.increaseBudget({ args: { itxns: 0 }, note: `${label}-refs-${i}-${noteNonce()}` })
  }
  return builder
}
