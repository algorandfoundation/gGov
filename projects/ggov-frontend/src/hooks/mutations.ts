import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { microAlgo } from '@algorandfoundation/algokit-utils'
import { getApplicationAddress } from 'algosdk'
import { useWallet } from '@txnlab/use-wallet-react'
import { toast } from 'sonner'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { fetchIsGGovAccount, queryKeys } from '@/hooks/queries'
import { signingProgress } from '@/lib/signingProgress'
import { GGovSDK } from 'ggov-sdk'
import type { Election, PeriodBodyJson, TopicBodyJson, GGovReaderSDK } from 'ggov-sdk'

function txnSuccessToast(message: string, data?: unknown) {
  const txIds = data && typeof data === 'object' && 'txIds' in data ? (data as { txIds: string[] }).txIds : undefined
  const txId = txIds && txIds.length > 0 ? txIds[txIds.length - 1] : undefined
  toast.success(
    message,
    txId
      ? {
          action: {
            label: 'Copy Txn ID',
            onClick: () => navigator.clipboard.writeText(txId),
          },
        }
      : undefined,
  )
}

export function useVoteMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; voterAccount: string; topicVotes: number[][] }) =>
      sdk!.vote({
        periodId: BigInt(args.periodId),
        voterAccount: args.voterAccount,
        topicVotes: args.topicVotes,
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.voteRecord(vars.periodId, vars.voterAccount) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Vote submitted', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/**
 * Cast a pooled ballot: an internal vote on one staking pool's frac *instance*,
 * weighted in AlgoQuarters rather than gGov votes.
 *
 * `voterAccount` is whose AlgoQuarters are cast — the signer itself, or an account
 * that delegated to the signer (the frac contract honours the same gGov delegation
 * as a direct vote). The instance maps its internal tally onto its escrows' gGov
 * power and **re-casts externally inside the same group**, which is why the gGov
 * period's own tallies and voter set are invalidated here alongside the frac
 * record: a pooled vote moves the period's numbers too.
 */
export function useFracVoteMutation() {
  const { getFracSDK } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async (args: {
      instanceNumId: number
      periodId: number
      voterAccount: string
      /** [topic][option] AlgoQuarters; every topic must total the voter's full AQ weight. */
      topicVotes: number[][]
    }) => {
      const sdk = await getFracSDK()
      // Unreachable from the UI (pooled rows only render when a frac registry is
      // configured and a wallet is connected), but a clear message beats a crash.
      if (!sdk) throw new Error('Pooled voting is not available on this network.')
      return sdk.vote({
        instanceNumId: args.instanceNumId,
        periodId: args.periodId,
        voterAccount: args.voterAccount,
        topicVotes: args.topicVotes,
      })
    },
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fracVotingRecords(vars.voterAccount, vars.periodId) })
      // Eligibility can flip on this vote (a delegate's cast is now overridable
      // only by the owner), so drop every canVote entry for the period.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'fracCanVote' })
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.voters(vars.periodId) })
      txnSuccessToast('Pooled vote submitted', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/**
 * Whether a `set_voting_account` for `account` needs the `fractionalOnly` flag.
 *
 * The registry's `ensureDelegatorRegistered` accepts a delegator known to *either*
 * registry: it checks its own `accounts` box first, and only on a miss inner-calls
 * the frac registry's `getAccount`. The SDK funds that extra inner call only when
 * `fractionalOnly` is set — so a pool member who has never produced a block
 * cannot delegate at all without it.
 *
 * Resolved per call rather than by a hook, because `useRedelegateMutation` acts on
 * a delegator that varies per invocation. Cached, so repeat delegations are free.
 */
async function needsFractionalOnly(
  queryClient: QueryClient,
  readerSDK: GGovReaderSDK,
  account: string,
): Promise<boolean> {
  try {
    const isGGovAccount = await queryClient.ensureQueryData({
      queryKey: queryKeys.isGGovAccount(account),
      queryFn: () => fetchIsGGovAccount(readerSDK, account),
      staleTime: 300_000,
    })
    return !isGGovAccount
  } catch {
    // If the lookup itself fails, opt in: the cost of a false positive is 0.001
    // ALGO of unused fee, while a false negative fails the transaction outright.
    return true
  }
}

export function useDelegateMutation() {
  const { sdk, readerSDK } = useGGovSDK()
  const { activeAddress } = useWallet()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async (delegatee: string) =>
      sdk!.setVotingAccount({
        votingAddress: delegatee,
        fractionalOnly: await needsFractionalOnly(queryClient, readerSDK, activeAddress!),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation set', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useUndelegateMutation() {
  const { sdk, readerSDK } = useGGovSDK()
  const { activeAddress } = useWallet()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async () =>
      sdk!.setVotingAccount({ fractionalOnly: await needsFractionalOnly(queryClient, readerSDK, activeAddress!) }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation removed', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/**
 * Redirect a delegation that was made *to* the signer onward to a third address. The signer must be
 * `account`'s current delegatee — the contract's `set_voting_account` allows the xgov_address itself
 * or its current voting_address to set it. After this the delegator moves off the signer's reverse
 * list onto the new delegatee's, so refresh both reverse indexes and the forward delegation.
 */
export function useRedelegateMutation() {
  const { sdk, readerSDK } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async (args: { account: string; votingAddress: string }) =>
      sdk!.setVotingAccount({
        account: args.account,
        votingAddress: args.votingAddress,
        // The delegator here is the incoming account, not the signer.
        fractionalOnly: await needsFractionalOnly(queryClient, readerSDK, args.account),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        predicate: (q) => ['delegation', 'delegatedToMe', 'allDelegations'].includes(q.queryKey[0] as string),
      })
      txnSuccessToast('Delegation redirected', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useAddPeriodMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async (args: {
      committeeId: Uint8Array
      votingStart: bigint
      votingEnd: bigint
      title?: string
      body?: string
      /** Present (non-empty) makes this an election period; see `PeriodBodyJson.elect`. */
      elect?: Election[]
    }) => {
      // A body is only uploaded (a second signed group) when a title is provided.
      const willUploadBody = !!args.title?.trim()
      const progress = signingProgress(willUploadBody ? 2 : 1)
      try {
        progress.step('Creating period')
        const periodId = (await sdk!.registry.addPeriod({
          committeeId: args.committeeId,
          votingStart: args.votingStart,
          votingEnd: args.votingEnd,
        })) as bigint

        if (willUploadBody) {
          progress.step('Uploading period body')
          await sdk!.uploadPeriodBody({
            periodId,
            body: {
              title: args.title!.trim(),
              body: args.body?.trim() ?? '',
              ...(args.elect?.length ? { elect: args.elect } : {}),
            },
          })
        }

        progress.done()
        return periodId
      } catch (e) {
        progress.fail()
        throw e
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast('Period created')
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useEditPeriodMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; committeeId: Uint8Array; votingStart: bigint; votingEnd: bigint }) =>
      sdk!.editPeriod({
        periodId: BigInt(args.periodId),
        committeeId: args.committeeId,
        votingStart: args.votingStart,
        votingEnd: args.votingEnd,
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Period updated', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useUploadPeriodBodyMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; body: PeriodBodyJson }) =>
      sdk!.uploadPeriodBody({
        periodId: BigInt(args.periodId),
        body: args.body,
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.periodBody(vars.periodId) })
      txnSuccessToast('Period body saved')
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useAddTopicMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: async (args: {
      periodId: number
      options: string[]
      title?: string
      body?: string
      /** Election index this candidate runs in, for an election period. */
      e?: number
    }) => {
      const title = args.title?.trim()
      // No body → a single plain addTopic. With a body → addTopicWithBody combines the topic and its
      // body into one signed group when it fits; a body too large to ride along falls back to two
      // signatures (addTopic, then the body upload), hence the group-count-driven progress indicator.
      if (!title) {
        return (await sdk!.addTopic({ periodId: BigInt(args.periodId), options: args.options })) as bigint
      }
      // The election tag rides in the same body write, so a candidate is created and assigned in
      // one signature — no follow-up call to place it.
      const body: TopicBodyJson = {
        title,
        body: args.body?.trim() ?? '',
        ...(args.e !== undefined ? { e: args.e } : {}),
      }
      const progress = signingProgress(GGovSDK.addTopicWithBodyGroupCount(body))
      try {
        const topicIndex = await sdk!.addTopicWithBody({
          periodId: BigInt(args.periodId),
          options: args.options,
          body,
          onSigningGroup: (i) => progress.step(i === 0 ? 'Adding topic' : 'Uploading topic body'),
        })
        progress.done()
        return topicIndex
      } catch (e) {
        progress.fail()
        throw e
      }
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      txnSuccessToast('Topic added')
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useEditTopicMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; topicIndex: number; options: string[] }) =>
      sdk!.editTopic({
        periodId: BigInt(args.periodId),
        topicIndex: BigInt(args.topicIndex),
        options: args.options,
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Topic updated', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useUploadTopicBodyMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; topicIndex: number; body: TopicBodyJson }) =>
      sdk!.uploadTopicBody({
        periodId: BigInt(args.periodId),
        topicIndex: BigInt(args.topicIndex),
        body: args.body,
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      txnSuccessToast('Topic body saved')
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/**
 * Remove a topic via the SDK's `removeCandidate`, not the bare `removeTopic`: the contract splices
 * the topic arrays but can't re-key the `T<index>` body boxes, so a bare removal leaves every later
 * topic reading the body — title *and* election tag — one index too high. `removeCandidate` shifts
 * the bodies down and drops the vacated box, at the cost of several wallet signatures.
 */
export function useRemoveTopicMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; topicIndex: number }) =>
      sdk!.removeCandidate({
        periodId: BigInt(args.periodId),
        topicIndex: BigInt(args.topicIndex),
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast('Topic removed', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/** Move a candidate to another election by rewriting the `e` tag in its own topic body. */
export function useSetCandidateElectionMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; topicIndex: number; e?: number }) =>
      sdk!.setCandidateElection({
        periodId: BigInt(args.periodId),
        topicIndex: BigInt(args.topicIndex),
        e: args.e,
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      txnSuccessToast('Candidate reassigned', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useSetReadyMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; ready: boolean }) =>
      sdk!.setReady({
        periodId: BigInt(args.periodId),
        ready: args.ready,
      }),
    onSuccess: (data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast(vars.ready ? 'Period marked ready' : 'Period marked draft', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

/**
 * Fund a registry app account by the amount the funding panel says it is short.
 *
 * An ordinary payment, not a contract call: both registries spend from their plain account balance,
 * and neither exposes (or needs) a deposit method. That is also why this serves the frac registry
 * without touching the frac SDK — a payment does not care what the receiver is, so a network with
 * pooled voting pays no extra bundle cost to fund it.
 *
 * Unlike the operator-gated writes above, nothing on chain restricts who may send it; the caller is
 * whichever wallet is connected.
 */
export function useTopUpRegistryMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { appId: bigint; amount: bigint; label: string }) =>
      sdk!.algorand.send.payment({
        sender: sdk!.writerAccount!.sender,
        signer: sdk!.writerAccount!.signer,
        receiver: getApplicationAddress(args.appId),
        amount: microAlgo(args.amount),
      }),
    onSuccess: (data, vars) => {
      // The panel reads straight off the app account, so its balance entry is the thing that moved.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appAccountInfo(vars.appId) })
      txnSuccessToast(`Topped up the ${vars.label} registry`, data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}
