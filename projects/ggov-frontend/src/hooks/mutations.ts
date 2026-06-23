import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { queryKeys } from '@/hooks/queries'
import { signingProgress } from '@/lib/signingProgress'
import type { BodyJson } from 'ggov-sdk'

function txnSuccessToast(message: string, data?: unknown) {
  const txIds = data && typeof data === 'object' && 'txIds' in data
    ? (data as { txIds: string[] }).txIds
    : undefined
  const txId = txIds && txIds.length > 0 ? txIds[txIds.length - 1] : undefined
  toast.success(message, txId ? {
    action: {
      label: 'Copy Txn ID',
      onClick: () => navigator.clipboard.writeText(txId),
    },
  } : undefined)
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
      queryClient.invalidateQueries({ queryKey: queryKeys.voteRecord(vars.periodId, vars.voterAccount) })
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Vote submitted', data)
    },
    onError: showError,
  })
}

export function useDelegateMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (delegatee: string) => sdk!.setVotingAccount({ votingAddress: delegatee }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation set', data)
    },
    onError: showError,
  })
}

export function useUndelegateMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: () => sdk!.setVotingAccount({}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation removed', data)
    },
    onError: showError,
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
      queryClient.invalidateQueries({
        predicate: (q) => ['delegation', 'delegatedToMe', 'allDelegations'].includes(q.queryKey[0] as string),
      })
      txnSuccessToast('Delegation redirected', data)
    },
    onError: showError,
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
        const periodId = await sdk!.registry.addPeriod({
          committeeId: args.committeeId,
          votingStart: args.votingStart,
          votingEnd: args.votingEnd,
        }) as bigint

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
      queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast('Period created')
    },
    onError: showError,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Period updated', data)
    },
    onError: showError,
  })
}

export function useUploadPeriodBodyMutation() {
  const { sdk } = useGGovSDK()
  const queryClient = useQueryClient()
  const { showError } = useErrorDialog()

  return useMutation({
    mutationFn: (args: { periodId: number; body: BodyJson }) =>
      sdk!.uploadPeriodBody({
        periodId: BigInt(args.periodId),
        body: args.body,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.periodBody(vars.periodId) })
      txnSuccessToast('Period body saved')
    },
    onError: showError,
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
    }) => {
      // A body is only uploaded (a second signed group) when a title is provided.
      const willUploadBody = !!args.title?.trim()
      const progress = signingProgress(willUploadBody ? 2 : 1)
      try {
        progress.step('Adding topic')
        const topicIndex = await sdk!.addTopic({
          periodId: BigInt(args.periodId),
          options: args.options,
        }) as bigint

        if (willUploadBody) {
          progress.step('Uploading topic body')
          await sdk!.uploadTopicBody({
            periodId: BigInt(args.periodId),
            topicIndex,
            body: { title: args.title!.trim(), body: args.body?.trim() ?? '' },
          })
        }

        progress.done()
        return topicIndex
      } catch (e) {
        progress.fail()
        throw e
      }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      txnSuccessToast('Topic added')
    },
    onError: showError,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      txnSuccessToast('Topic updated', data)
    },
    onError: showError,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      txnSuccessToast('Topic body saved')
    },
    onError: showError,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.topicBodies(vars.periodId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast('Topic removed', data)
    },
    onError: showError,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.period(vars.periodId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.periods })
      txnSuccessToast(vars.ready ? 'Period marked ready' : 'Period marked draft', data)
    },
    onError: showError,
  })
}
