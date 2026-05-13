import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { queryKeys } from '@/hooks/queries'
import type { BodyJson } from 'ggov-sdk'

function txnSuccessToast(message: string, data?: unknown) {
  const txIds = data && typeof data === 'object' && 'txIds' in data
    ? (data as { txIds: string[] }).txIds
    : undefined
  const txId = txIds?.at(-1)
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
    mutationFn: (delegatee: string) => sdk!.delegate({ delegatee }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.delegation('') })
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
    mutationFn: () => sdk!.undelegate({}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'delegation' })
      txnSuccessToast('Delegation removed', data)
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
    }) => {
      const periodId = await sdk!.addPeriod({
        committeeId: args.committeeId,
        votingStart: args.votingStart,
        votingEnd: args.votingEnd,
      }) as bigint

      if (args.title?.trim()) {
        await sdk!.uploadPeriodBody({
          periodId,
          body: { title: args.title.trim(), body: args.body?.trim() ?? '' },
        })
      }

      return periodId
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
      const topicIndex = await sdk!.addTopic({
        periodId: BigInt(args.periodId),
        options: args.options,
      }) as bigint

      if (args.title?.trim()) {
        await sdk!.uploadTopicBody({
          periodId: BigInt(args.periodId),
          topicIndex,
          body: { title: args.title.trim(), body: args.body?.trim() ?? '' },
        })
      }

      return topicIndex
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
