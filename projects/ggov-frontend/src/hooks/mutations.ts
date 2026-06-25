import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { queryKeys } from '@/hooks/queries'
import { signingProgress } from '@/lib/signingProgress'
import { GGovSDK } from 'ggov-sdk'
import type { BodyJson, PeriodBodyJson } from 'ggov-sdk'

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

export function useDelegateMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (delegatee: string) => sdk!.setVotingAccount({ votingAddress: delegatee }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation set', data)
    },
    onError: (err) => showError(err, { transaction: true }),
  })
}

export function useUndelegateMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: () => sdk!.setVotingAccount({}),
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
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { account: string; votingAddress: string }) =>
      sdk!.setVotingAccount({ account: args.account, votingAddress: args.votingAddress }),
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
      electSeats?: number
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
              ...(args.electSeats !== undefined ? { electSeats: args.electSeats } : {}),
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
    mutationFn: async (args: { periodId: number; options: string[]; title?: string; body?: string }) => {
      const title = args.title?.trim()
      // No body → a single plain addTopic. With a body → addTopicWithBody combines the topic and its
      // body into one signed group when it fits; a body too large to ride along falls back to two
      // signatures (addTopic, then the body upload), hence the group-count-driven progress indicator.
      if (!title) {
        return (await sdk!.addTopic({ periodId: BigInt(args.periodId), options: args.options })) as bigint
      }
      const body: BodyJson = { title, body: args.body?.trim() ?? '' }
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
    mutationFn: (args: { periodId: number; topicIndex: number; body: BodyJson }) =>
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

export function useRemoveTopicMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; topicIndex: number }) =>
      sdk!.removeTopic({
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
