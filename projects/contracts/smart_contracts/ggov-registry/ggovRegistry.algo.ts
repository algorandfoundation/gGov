import {
  Account,
  Application,
  baremethod,
  Box,
  BoxMap,
  bytes,
  Bytes,
  clone,
  compile,
  contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  log,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { abimethod, compileArc4, decodeArc4, encodeArc4, Uint32 } from '@algorandfoundation/algorand-typescript/arc4'
import { sbAppend, sbCreate, sbDeleteIndex, sbDeleteSuperbox, sbGetData } from '@d13co/superbox'
import { SuperboxMeta } from '@d13co/superbox/smart_contracts/superbox/lib/types.algo'
import { sbDataBoxRef, sbMetaBox } from '@d13co/superbox/smart_contracts/superbox/lib/utils.algo'
import {
  errAccountNotExists,
  errAccountOffsetMismatch,
  errCommitteeExists,
  errCommitteeIdOverflow,
  errCommitteeIncomplete,
  errCommitteeNotExists,
  errGGovDelegationExists,
  errGGovPeriodNotExists,
  errGGovSelfDelegate,
  errIngestedVotesNotZero,
  errNumXGovsExceeded,
  errOutOfOrder,
  errPeriodAppNotConfigured,
  errPeriodEndLessThanStart,
  errTotalMembersOverflow,
  errTotalMembersZero,
  errTotalVotesExceeded,
  errTotalVotesMismatch,
  errTotalVotesZero,
  errTotalXGovsExceeded,
  errUnauthorized,
  errZeroVotes,
} from '../base/errors.algo'
import {
  ACCOUNT_ID_WITH_VOTES_STORED_SIZE,
  AccountIdWithVotes,
  AccountWithVotes,
  CommitteeId,
  CommitteeMetadata,
  GGovPeriodSummary,
  getEmptyCommitteeMetadata,
  getEmptyGGovPeriodSummary,
} from '../base/types.algo'
import { ensure, ensureExtra, u16, u32 } from '../base/utils.algo'
import { GGovPeriodContract } from '../ggov-period/ggovPeriod.algo'
import { XGovRegistryMock } from '../xgov-registry-mock/xGovRegistryMock.algo'
import { GGovRegistryAccountContract } from './ggovRegistryAccount.algo'

/**
 * Count total xGovs stored in committee superbox
 */
function getCommitteeSBXGovs(sbMeta: Box<SuperboxMeta>): uint64 {
  return sbMeta.value.totalByteLength.asUint64() / ACCOUNT_ID_WITH_VOTES_STORED_SIZE
}

export const ggovRegistryXGovKey = Bytes`xGovRegistryApp`

@contract({ name: 'GGovRegistry', stateTotals: { globalBytes: 20, globalUints: 44 } })
export class GGovRegistryContract extends GGovRegistryAccountContract {
  /** xGov registry application ID */
  xGovRegistryApp = GlobalState<Application>({ key: ggovRegistryXGovKey })
  /** Committee metadata box map */
  committees = BoxMap<CommitteeId, CommitteeMetadata>({ keyPrefix: 'c' })
  /** Last committee numeric ID; superbox prefix for committees */
  lastCommitteeId = GlobalState<uint64>({ initialValue: 0 })

  /** Admin address; defaults to creator. Rotatable via setAdmin. */
  admin = GlobalState<Account>({ initialValue: Global.creatorAddress })
  /** Operator address (manages periods on spawned ggov-period apps) */
  operator = GlobalState<Account>()
  /** Auto-increment period IDs */
  lastPeriodId = GlobalState<uint64>({ initialValue: 0 })
  /** Per-period summary: periodId → { appId, votingStart, votingEnd, numTopics } */
  periods = BoxMap<Uint32, GGovPeriodSummary>({ keyPrefix: 'p' })
  /** Delegator → delegatee mapping (gGov voting delegations) */
  delegations = BoxMap<Account, Account>({ keyPrefix: 'd' })
  /**
   * Reverse delegation index: delegatee → delegator addresses. Maintained in lockstep with
   * `delegations` so the frontend can answer "who delegated to me?" with a single box read
   * keyed by the delegatee, instead of scanning every forward delegation.
   *
   * TODO this is a plain box holding a dynamic `Account[]`, so a single delegatee's list is
   * bounded by the 32KB box ceiling (~1024 addresses) and every add/remove rewrites the whole box.
   * If a delegatee can accrue many delegators, consider migrating this to a superbox.
   */
  reverseDelegations = BoxMap<Account, Account[]>({ keyPrefix: 'D' })
  /**
   * GGovPeriod approval program bytecode. Chunk-uploaded by admin; read by createPeriod
   * when spawning a new period app. Lets admins ship period approval-program upgrades
   * without redeploying the registry. Existing periods are independent apps and are
   * unaffected.
   */
  periodApprovalBox = Box<bytes>({ key: 'Pap' })

  /**
   * Register a committee
   * @param committeeId Committee ID
   * @param periodStart Period start
   * @param periodEnd Period end
   * @param totalMembers Total xGovs
   * @param totalVotes Total votes in committee
   */
  public registerCommittee(
    committeeId: CommitteeId,
    periodStart: Uint32,
    periodEnd: Uint32,
    totalMembers: Uint32,
    totalVotes: Uint32,
    xGovRegistryId: uint64,
  ): void {
    this.ensureCallerIsAdmin()

    const committeeBox = this.committees(committeeId)
    ensure(!committeeBox.exists, errCommitteeExists)
    ensure(periodEnd.asUint64() > periodStart.asUint64(), errPeriodEndLessThanStart)
    ensure(totalMembers.asUint64() > 0, errTotalMembersZero)
    ensure(totalVotes.asUint64() > 0, errTotalVotesZero)
    ensure(totalMembers.asUint64() <= 65535, errTotalMembersOverflow)
    ensure(this.lastCommitteeId.value <= 65535, errCommitteeIdOverflow)
    committeeBox.value = {
      periodStart,
      periodEnd,
      totalMembers,
      totalVotes,
      xGovRegistryId,
      ingestedVotes: u32(0),
      numericId: u16(this.lastCommitteeId.value),
    }
    sbCreate(this.getCommitteeSBPrefix(committeeId), 2048, ACCOUNT_ID_WITH_VOTES_STORED_SIZE, '[uint32,uint32]')
    this.lastCommitteeId.value = this.lastCommitteeId.value + 1
  }

  /**
   * Delete committee. Must not have any xGovs
   * @param committeeId committee ID
   */
  public unregisterCommittee(committeeId: CommitteeId): void {
    this.ensureCallerIsAdmin()

    const committeeBox = this.committees(committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    ensure(committeeBox.value.ingestedVotes === u32(0), errIngestedVotesNotZero)
    sbDeleteSuperbox(this.getCommitteeSBPrefix(committeeId))
    committeeBox.delete()
  }

  /**
   * Ingest xGovs into a committee
   * @param committeeId committee ID
   * @param xGovs xGovs to ingest
   */
  public ingestXGovs(committeeId: CommitteeId, xGovs: AccountWithVotes[]): void {
    this.ensureCallerIsAdmin()

    const committee = this.mustGetCommitteeMetadata(committeeId)
    const superboxName = this.getMetadataSBPrefix(committee)
    const sbMeta = sbMetaBox(superboxName)
    // figure out ingested accounts from superbox size
    const ingestedAccounts: uint64 = getCommitteeSBXGovs(sbMeta)
    // not exceeding total xGovs
    ensure(ingestedAccounts + xGovs.length <= committee.totalMembers.asUint64(), errTotalXGovsExceeded)

    let lastAccountId = u32(0)
    if (ingestedAccounts > 0) {
      const lastXGov = this.getStoredXGovAt(superboxName, ingestedAccounts - 1)
      lastAccountId = lastXGov.accountId
    }

    let ingestedAccountCtr = ingestedAccounts
    let ingestedVotes = committee.ingestedVotes.asUint64()
    let writeBuffer = Bytes``
    for (const xGov of clone(xGovs)) {
      // reject zero-vote xGovs; they carry no voting power and would skew totals/member counts
      ensure(xGov.votes.asUint64() > 0, errZeroVotes)
      const gGovAccount = this.getOrCreateAccount(xGov.account)
      const accountId = gGovAccount.accountId
      // ensure xGovs are added in ascending order
      ensure(accountId.asUint64() > lastAccountId.asUint64(), errOutOfOrder)
      // store variant removes account
      const xGovStored: AccountIdWithVotes = {
        accountId: accountId,
        votes: xGov.votes,
      }
      // append to write buffer, write to superbox once
      writeBuffer = writeBuffer.concat(encodeArc4(xGovStored))
      this.addCommitteeAccountOffsetHint(committee.numericId, xGov.account, gGovAccount, u16(ingestedAccountCtr++))
      lastAccountId = accountId
      ingestedVotes += xGov.votes.asUint64()
    }

    // ensure we did not exceed total votes
    ensure(ingestedVotes <= committee.totalVotes.asUint64(), errTotalVotesExceeded)

    log(sbAppend(superboxName, writeBuffer))

    committee.ingestedVotes = u32(ingestedVotes)
    // if we are finished, ensure total votes match
    if (ingestedAccounts + xGovs.length === committee.totalMembers.asUint64()) {
      ensure(committee.ingestedVotes === committee.totalVotes, errTotalVotesMismatch)
    }
    this.committees(committeeId).value = clone(committee)
  }

  /**
   * Uningest last N xGovs from committee
   * @param committeeId committee ID
   * @param numXGovs xGovs to uningest, strictly descending order
   */
  public uningestXGovs(committeeId: CommitteeId, xGovs: Account[]): void {
    this.ensureCallerIsAdmin()
    const committee = this.mustGetCommitteeMetadata(committeeId)
    const superboxName = this.getMetadataSBPrefix(committee)
    const sbMeta = sbMetaBox(superboxName)
    const totalXGovs = getCommitteeSBXGovs(sbMeta)
    ensure(xGovs.length <= totalXGovs, errNumXGovsExceeded)
    let ingestedVotes = committee.ingestedVotes.asUint64()
    let expectedXGovOffset = totalXGovs
    for (const account of clone(xGovs)) {
      expectedXGovOffset--
      const gGovAccount = this.mustGetAccount(account)
      const offset = this.getCommitteeAccountOffsetHint(committee.numericId, gGovAccount)
      ensureExtra(expectedXGovOffset === offset, errOutOfOrder, account.bytes)
      const xGovStored = this.getStoredXGovAt(superboxName, offset)
      this.removeCommitteeAccountOffsetHint(committee.numericId, account, gGovAccount)
      sbDeleteIndex(superboxName, offset)
      ingestedVotes -= xGovStored.votes.asUint64()
    }
    committee.ingestedVotes = u32(ingestedVotes)
    this.committees(committeeId).value = clone(committee)
  }

  /**
   * Set the xGov Registry Application ID
   * @param appId xGov Registry Application ID
   */
  public setXGovRegistryApp(appId: Application): void {
    this.ensureCallerIsAdmin()
    this.xGovRegistryApp.value = appId
  }

  // ── Admin ─────────────────────────────────────────────────────────

  /** Override base check: caller must match this registry's stored admin (not the contract creator). */
  protected override ensureCallerIsAdmin(): void {
    ensure(Txn.sender === this.admin.value, errUnauthorized)
  }

  /** Transfer admin to $newAdmin. Admin only; zero address rejected. */
  public setAdmin(newAdmin: Account): void {
    this.ensureCallerIsAdmin()
    ensure(newAdmin !== Global.zeroAddress, errUnauthorized)
    this.admin.value = newAdmin
  }

  /**
   * Withdraw $amount microALGO from the registry app account to $receiver. Admin only.
   * The AVM rejects the inner payment if it would drop the app account below its min
   * balance, so over-withdrawal fails atomically (no explicit balance check needed).
   */
  public withdrawALGO(receiver: Account, amount: uint64): void {
    this.ensureCallerIsAdmin()
    ensure(receiver !== Global.zeroAddress, errUnauthorized)
    itxn.payment({ receiver, amount }).submit()
  }

  /** Whether $account is the admin. Called by period contracts via inner txn. */
  @abimethod({ readonly: true })
  public verifyAdmin(account: Account): boolean {
    return account === this.admin.value
  }

  /** App updatable by admin */
  @baremethod({ allowActions: ['UpdateApplication'] })
  public updateApplication(): void {
    this.ensureCallerIsAdmin()
  }

  /** App deletable by admin */
  @baremethod({ allowActions: ['DeleteApplication'] })
  public deleteApplication(): void {
    this.ensureCallerIsAdmin()
  }

  // ── Operator + delegations ────────────────────────────────────────

  /** Set the operator account (manages periods on spawned ggov-period apps). */
  public setOperator(account: Account): void {
    this.ensureCallerIsAdmin()
    this.operator.value = account
  }

  /** Whether $account is the registered operator. Called by period contracts via inner txn. */
  @abimethod({ readonly: true })
  public verifyOperator(account: Account): boolean {
    return account === this.operator.value
  }

  /**
   * xGov-registry-compatible delegation entrypoint. The ABI selector equals the xGov registry's
   * `set_voting_account(address,address)void`, so callers/tooling built for the xGov registry work
   * unchanged against gGov. Maps xGov's (xgov_address, voting_address) onto gGov's (delegator,
   * delegatee):
   *  - `votingAddress === xgovAddress` is xGov's "vote for self" (no external delegation) and clears
   *    any existing gGov delegation.
   *  - otherwise records the delegation `xgovAddress → votingAddress`.
   * Authorization matches xGov: the xgov_address itself OR its current delegatee may set it.
   */
  @abimethod({ name: 'set_voting_account' })
  public setVotingAccount(xgovAddress: Account, votingAddress: Account): void {
    ensure(this.accounts(xgovAddress).exists, errAccountNotExists) // xGov NOT_XGOV analog
    this.ensureCallerCanManageDelegation(xgovAddress)
    if (votingAddress === xgovAddress) {
      this.removeDelegation(xgovAddress)
    } else {
      this.addDelegation(xgovAddress, votingAddress)
    }
  }

  /** Mirror delegation from the xGov registry's box (if present). Admin only. */
  public mirrorXGovDelegation(account: Account): void {
    this.ensureCallerIsAdmin()
    // never overwrite an existing gGov delegation; mirroring only seeds delegations not yet set locally
    ensure(!this.delegations(account).exists, errGGovDelegationExists)

    const registry = compileArc4(XGovRegistryMock)
    const [xGovBox, exists] = registry.call.getXGovBox({
      appId: this.xGovRegistryApp.value,
      args: [account],
    }).returnValue

    // Skip self-delegation (xGov "vote for self" == no delegation) so addDelegation never rejects.
    if (exists && xGovBox.votingAddress !== Global.zeroAddress && xGovBox.votingAddress !== account) {
      this.addDelegation(account, xGovBox.votingAddress)
    }
  }

  /**
   * Record a delegation from $delegator to $delegatee, keeping the forward (`delegations`) and
   * reverse (`reverseDelegations`) indexes in sync. Single entry point for adding a delegation —
   * reused by `delegate` and `mirrorXGovDelegation`. Re-delegating moves the delegator's address
   * off the previous delegatee's reverse list onto the new one.
   */
  private addDelegation(delegator: Account, delegatee: Account): void {
    ensure(delegator !== delegatee, errGGovSelfDelegate)
    // only existing accounts can delegate; prevents spamming delegations from random addresses and keeps reverse index clean
    ensure(this.accounts(delegator).exists, errAccountNotExists)
    const fwd = this.delegations(delegator)
    if (fwd.exists) {
      const previousDelegatee = fwd.value
      if (previousDelegatee === delegatee) return // unchanged; reverse index already correct
      this.removeReverseDelegation(previousDelegatee, delegator)
    }
    fwd.value = delegatee
    this.addReverseDelegation(delegatee, delegator)
  }

  /**
   * Caller may manage $delegator's delegation if they are the delegator themselves or its current
   * delegatee. Reused by `setVotingAccount` to match the xGov registry's auth rule (xgov_address or
   * current voting_address).
   */
  private ensureCallerCanManageDelegation(delegator: Account): void {
    const box = this.delegations(delegator)
    const isCurrentDelegatee = box.exists && box.value === Txn.sender
    ensure(Txn.sender === delegator || isCurrentDelegatee, errUnauthorized)
  }

  /** Remove $delegator's delegation if present (idempotent), keeping the reverse index in sync. */
  private removeDelegation(delegator: Account): void {
    const box = this.delegations(delegator)
    if (!box.exists) return
    this.removeReverseDelegation(box.value, delegator)
    box.delete()
  }

  /** Append $delegator to $delegatee's reverse delegation list. */
  private addReverseDelegation(delegatee: Account, delegator: Account): void {
    const box = this.reverseDelegations(delegatee)
    const list: Account[] = []
    if (box.exists) {
      for (const addr of clone(box.value)) list.push(addr)
    }
    list.push(delegator)
    box.value = clone(list)
  }

  /** Remove $delegator from $delegatee's reverse delegation list; delete the box when empty. */
  private removeReverseDelegation(delegatee: Account, delegator: Account): void {
    const box = this.reverseDelegations(delegatee)
    if (!box.exists) return
    const next: Account[] = []
    for (const addr of clone(box.value)) {
      if (addr !== delegator) next.push(addr)
    }
    if (next.length === 0) {
      box.delete()
    } else {
      box.value = clone(next)
    }
  }

  /** Get delegation: [delegatee, exists]. */
  @abimethod({ readonly: true })
  public getDelegation(account: Account): [Account, boolean] {
    const box = this.delegations(account)
    if (box.exists) return [box.value, true]
    return [Global.zeroAddress, false]
  }

  /** Resolve the delegatee address (or zero address if none). Called by period contracts. */
  @abimethod({ readonly: true })
  public getDelegate(account: Account): Account {
    const box = this.delegations(account)
    if (box.exists) return box.value
    return Global.zeroAddress
  }

  /** Log the addresses that have delegated to $delegatee (reverse lookup), one per log line. */
  @abimethod({ readonly: true })
  public logDelegators(delegatee: Account): void {
    // TODO with limited delegations (~1024) this is fine
    // but if we migrate reverse delegations to a superbox, we could exceed the simulate+allowMoreLogging limits (2048 calls, 65K total log bytes)
    const box = this.reverseDelegations(delegatee)
    if (!box.exists) return
    for (const delegator of clone(box.value)) {
      log(encodeArc4(delegator))
    }
  }

  /** Batch log delegations. */
  @abimethod({ readonly: true })
  public logDelegations(accounts: Account[]): void {
    for (const account of accounts) {
      const box = this.delegations(account)
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(Global.zeroAddress))
      }
    }
  }

  // ── Period app bytecode (admin-managed) ──────────────────────────

  /**
   * Upload (or re-upload) a chunk of the GGovPeriod approval bytecode into a registry box.
   * Admin only. `startOffset === 0` deletes the existing box and creates a fresh one at
   * the chunk length; subsequent chunks resize/replace.
   */
  public uploadPeriodApprovalPartial(startOffset: uint64, data: bytes, last: boolean): void {
    this.ensureCallerIsAdmin()
    const boxKey = Bytes`Pap`
    const writeEnd: uint64 = startOffset + data.length
    if (startOffset === 0) {
      op.Box.delete(boxKey)
      op.Box.create(boxKey, writeEnd)
    } else {
      const [boxLen] = op.Box.length(boxKey)
      if (writeEnd > boxLen) {
        op.Box.resize(boxKey, writeEnd)
      }
    }
    op.Box.replace(boxKey, startOffset, data)
  }

  // ── Periods registry ──────────────────────────────────────────────

  /**
   * Spawn a fresh ggov-period app for $committeeId.
   * @param mbrPayment Payment txn covering the new period app's MBR. Receiver must be this registry's address.
   * @returns [periodId, appId]
   */
  public createPeriod(
    committeeId: CommitteeId,
    votingStart: uint64,
    votingEnd: uint64,
    mbrPayment: gtxn.PaymentTxn,
  ): [Uint32, uint64] {
    ensure(Txn.sender === this.operator.value, errUnauthorized)
    ensure(votingEnd > votingStart, errPeriodEndLessThanStart)
    ensure(mbrPayment.receiver === Global.currentApplicationAddress, errUnauthorized)

    const committeeBox = this.committees(committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    ensure(committeeBox.value.ingestedVotes === committeeBox.value.totalVotes, errCommitteeIncomplete)

    ensure(this.periodApprovalBox.exists, errPeriodAppNotConfigured)

    this.lastPeriodId.value++
    const periodId = u32(this.lastPeriodId.value)

    // IMPORTANT: Always allocate the MAXIMUM AVM extraProgramPages (3) and reserve 2 extra
    // slots in each global-schema dimension (uint + bytes). This headroom lets the
    // period contract grow up to the AVM hard ceiling without ever requiring a registry
    // redeploy. Do NOT shrink these constants when adding fields to GGovPeriodContract.
    const PERIOD_GLOBAL_NUM_UINT: uint64 = 7 // 5 used today + 2 reserved
    const PERIOD_GLOBAL_NUM_BYTES: uint64 = 3 // 1 used today + 2 reserved
    const PERIOD_EXTRA_PROGRAM_PAGES: uint64 = 3 // AVM max → 8192-byte approval/clear ceiling

    // AVM stack-bytes values are capped at 4096 bytes; approval can be up to 8192. Read the
    // approval box in two pages and pass them as a tuple. The AVM concatenates pages back
    // together at appcreate time; an empty trailing page is a no-op.
    const approvalKey = Bytes`Pap`
    const [approvalLen] = op.Box.length(approvalKey)
    const PAGE_SIZE: uint64 = 4096
    const page1Len: uint64 = approvalLen <= PAGE_SIZE ? approvalLen : PAGE_SIZE
    const page1: bytes = op.Box.extract(approvalKey, 0, page1Len)
    const page2: bytes =
      approvalLen > PAGE_SIZE ? op.Box.extract(approvalKey, PAGE_SIZE, approvalLen - PAGE_SIZE) : Bytes('')

    const compiled = compile(GGovPeriodContract) // clearStateProgram only — approval comes from box
    const created = itxn
      .applicationCall({
        approvalProgram: [page1, page2],
        clearStateProgram: compiled.clearStateProgram,
        extraProgramPages: PERIOD_EXTRA_PROGRAM_PAGES,
        globalNumUint: PERIOD_GLOBAL_NUM_UINT,
        globalNumBytes: PERIOD_GLOBAL_NUM_BYTES,
      })
      .submit()
    const newAppId = created.createdApp

    itxn
      .payment({
        receiver: newAppId.address,
        amount: mbrPayment.amount,
      })
      .submit()

    compileArc4(GGovPeriodContract).call.init({
      appId: newAppId,
      args: [Global.currentApplicationId, periodId, committeeId, u32(votingStart), u32(votingEnd)],
    })

    this.periods(periodId).value = {
      appId: newAppId.id,
      votingStart: u32(votingStart),
      votingEnd: u32(votingEnd),
      numTopics: u32(0),
      ready: false,
    }

    return [periodId, newAppId.id]
  }

  /**
   * Update period summary. Called as an inner txn from the period app registered for $periodId
   * (the only path that can mutate the summary). Trust boundary: caller-app ID must match
   * the registered appId for that periodId.
   */
  public updatePeriodSummary(
    periodId: Uint32,
    votingStart: Uint32,
    votingEnd: Uint32,
    numTopics: Uint32,
    ready: boolean,
  ): void {
    const box = this.periods(periodId)
    ensure(box.exists, errGGovPeriodNotExists)
    const summary = clone(box.value)
    ensure(Global.callerApplicationId === summary.appId, errUnauthorized)
    summary.votingStart = votingStart
    summary.votingEnd = votingEnd
    summary.numTopics = numTopics
    summary.ready = ready
    box.value = clone(summary)
  }

  /** Get the spawned period app ID for $periodId (0 if unknown). */
  @abimethod({ readonly: true })
  public getPeriodApp(periodId: uint64): uint64 {
    const box = this.periods(u32(periodId))
    if (box.exists) return box.value.appId
    return 0
  }

  /** Get the period summary (or empty if $periodId is unknown). */
  @abimethod({ readonly: true })
  public getPeriodSummary(periodId: uint64): GGovPeriodSummary {
    const box = this.periods(u32(periodId))
    if (box.exists) return box.value
    return getEmptyGGovPeriodSummary()
  }

  /** Batch log period summaries in input order. */
  @abimethod({ readonly: true })
  public logPeriodSummaries(periodIds: uint64[]): void {
    for (const periodId of periodIds) {
      const box = this.periods(u32(periodId))
      if (box.exists) {
        log(encodeArc4(box.value))
      } else {
        log(encodeArc4(getEmptyGGovPeriodSummary()))
      }
    }
  }

  /*
   * Read methods
   */

  /**
   * Get committee metadata
   * @param committeeId Committee ID
   * @param mustBeComplete Whether committee must be complete (all votes ingested)
   * @returns CommitteeMetadata
   */
  @abimethod({ readonly: true })
  public getCommitteeMetadata(committeeId: CommitteeId, mustBeComplete: boolean): CommitteeMetadata {
    const committeeBox = this.committees(committeeId)
    if (committeeBox.exists) {
      if (mustBeComplete) {
        ensure(committeeBox.value.ingestedVotes === committeeBox.value.totalVotes, errCommitteeIncomplete)
      }
      return committeeBox.value
    }
    return getEmptyCommitteeMetadata()
  }

  /**
   * Log committee metadata for multiple committees
   * @param committeeIds
   */
  @abimethod({ readonly: true })
  public logCommitteeMetadata(committeeIds: CommitteeId[]): void {
    for (const committeeId of committeeIds) {
      const metadata = this.committees(committeeId)
      if (metadata.exists) {
        log(encodeArc4(metadata.value))
      } else {
        log(encodeArc4(getEmptyCommitteeMetadata()))
      }
    }
  }

  /**
   * Facilitates fetching committee in "one shot" / parallel queries
   * if logMetadata is true, log committee metadata and superbox metadata (which includes total xGovs)
   * then log $dataPageLength number of xGov data boxes, starting from $startDataPage
   * @param committeeId
   * @param logMetadata
   * @param startDataPage
   * @param dataPageLength
   */
  @abimethod({ readonly: true })
  public logCommitteePages(
    committeeId: CommitteeId,
    logMetadata: boolean,
    startDataPage: uint64,
    dataPageLength: uint64,
  ): void {
    // log metadata and superbox meta on first page
    const committeeMetadata = this.mustGetCommitteeMetadata(committeeId)
    const superboxPrefix = this.getMetadataSBPrefix(committeeMetadata)
    const sbMetaBoxRef = sbMetaBox(superboxPrefix)
    ensure(sbMetaBoxRef.exists, errCommitteeNotExists)
    const sbMeta = clone(sbMetaBoxRef.value)
    if (logMetadata) {
      log(encodeArc4(committeeMetadata))
      log(encodeArc4(sbMeta))
    }

    // log data pages. allow calling more pages than exist, log empty if page exceeds data
    const maxDataPages = sbMeta.boxByteLengths.length
    for (let i: uint64 = 0; i < dataPageLength; i++) {
      const page: uint64 = startDataPage + i
      if (page >= maxDataPages) {
        log(Bytes``) // no page at index; logging empty
      } else {
        log(sbDataBoxRef(superboxPrefix, page).value)
      }
    }
  }

  /**
   * Get committee superbox metadata
   * @param committeeId
   * @returns SuperboxMeta
   */
  @abimethod({ readonly: true })
  public getCommitteeSuperboxMeta(committeeId: CommitteeId): SuperboxMeta {
    const superboxName = this.getCommitteeSBPrefix(committeeId)
    return sbMetaBox(superboxName).value
  }

  /**
   * Get xGov voting power
   * @param committeeId Committee ID
   * @param account xGov account
   * @returns xGov voting power
   */
  @abimethod({ readonly: true })
  public getXGovVotingPower(committeeId: CommitteeId, account: Account): Uint32 {
    const committeeMetadata = this.mustGetCommitteeMetadata(committeeId)

    const gGovAccount = this.getAccountIfExists(account)
    ensure(gGovAccount.accountId.asUint64() !== 0, errAccountNotExists)

    const accountOffset = this.getCommitteeAccountOffsetHint(committeeMetadata.numericId, gGovAccount)
    const xGov = this.getStoredXGovAt(this.getMetadataSBPrefix(committeeMetadata), accountOffset)
    ensureExtra(xGov.accountId === gGovAccount.accountId, errAccountOffsetMismatch, gGovAccount.accountId.bytes)

    return xGov.votes
  }

  /**
   * Non-throwing variant of getXGovVotingPower. Returns 0 if account/committee unknown
   * or the account is not a member of the committee. Used by ggov-period's canVote.
   */
  @abimethod({ readonly: true })
  public tryGetXGovVotingPower(committeeId: CommitteeId, account: Account): Uint32 {
    const committeeBox = this.committees(committeeId)
    if (!committeeBox.exists) return u32(0)
    const committeeMetadata = clone(committeeBox.value)

    const gGovAccount = this.getAccountIfExists(account)
    if (gGovAccount.accountId.asUint64() === 0) return u32(0)

    let foundOffset: uint64 = 0
    let found = false
    for (const [cNumId, off] of clone(gGovAccount.committeeOffsets)) {
      if (cNumId.asUint64() === committeeMetadata.numericId.asUint64()) {
        foundOffset = off.asUint64()
        found = true
      }
    }
    if (!found) return u32(0)

    const xGov = this.getStoredXGovAt(this.getMetadataSBPrefix(committeeMetadata), foundOffset)
    if (xGov.accountId.asUint64() !== gGovAccount.accountId.asUint64()) return u32(0)
    return xGov.votes
  }

  /**
   * Get committee metadata box value or fail
   * @param committeeId
   * @returns Committee
   */
  private mustGetCommitteeMetadata(committeeId: CommitteeId): CommitteeMetadata {
    const committeeBox = this.committees(committeeId)
    ensure(committeeBox.exists, errCommitteeNotExists)
    return committeeBox.value
  }

  /**
   * Get committee superbox prefix
   * @param committeeId
   * @returns committee superbox prefix
   */
  private getCommitteeSBPrefix(committeeId: CommitteeId): string {
    return this.getMetadataSBPrefix(this.mustGetCommitteeMetadata(committeeId))
  }

  /**
   * Get superbox prefix from already-loaded committee metadata
   * Avoids redundant box reads when metadata is already available
   */
  private getMetadataSBPrefix(metadata: CommitteeMetadata): string {
    return 'S' + metadata.numericId.asUint64().toString()
  }

  /**
   * Get xgov stored at index in committee superbox
   * @param superboxName committee superbox name
   * @param index offset
   * @returns xGov account ID and votes stored at index
   */
  private getStoredXGovAt(superboxName: string, index: uint64): AccountIdWithVotes {
    const xGovData = sbGetData(superboxName, index)
    return decodeArc4<AccountIdWithVotes>(xGovData)
  }
}
