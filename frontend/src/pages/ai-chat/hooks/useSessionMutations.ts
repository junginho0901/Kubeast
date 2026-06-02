import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { api, Session } from '@/services/api'
import type { Message } from '../types'

// 세션 3 mutation (create / delete / update title). create 는 optimistic
// session 으로 sidebar 즉시 반영하고, onSuccess 에서 진짜 session 으로 교체.
// 이 dance 는 첫 질문에서 "send → 대화방 표시" 지연을 없애기 위함.

interface Params {
  upsertSessionAtFront: (s: Session, oldId?: string) => void
  setPinnedSessions: React.Dispatch<React.SetStateAction<Record<string, Session>>>
  setViewSessionId: (id: string | null) => void
  setSelectedSessionId: (id: string | null) => void
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  selectedSessionId: string | null
}

export function useSessionMutations({
  upsertSessionAtFront,
  setPinnedSessions,
  setViewSessionId,
  setSelectedSessionId,
  setMessages,
  selectedSessionId,
}: Params) {
  const queryClient = useQueryClient()

  // 세션 생성 (첫 질문에서만 필요)
  const createSessionMutation = useMutation({
    mutationFn: ({ title }: { title: string; optimisticId: string }) => api.createSession(title || 'New Chat'),
    onMutate: async ({ title, optimisticId }: { title: string; optimisticId: string }) => {
      const previousSessions = queryClient.getQueryData<InfiniteData<Session[]>>(['sessions'])
      const nowIso = new Date().toISOString()

      const optimisticSession: Session = {
        id: optimisticId,
        title: title || 'New Chat',
        created_at: nowIso,
        updated_at: nowIso,
        message_count: 0,
      }

      upsertSessionAtFront(optimisticSession)

      // 즉시 UI에 반영 후, 백그라운드에서 기존 세션 fetch를 취소
      void queryClient.cancelQueries({ queryKey: ['sessions'] })
      setViewSessionId(optimisticId)
      return { previousSessions, optimisticId }
    },
    onSuccess: (newSession, _vars, ctx) => {
      // optimistic session을 실제 session으로 교체 (세션 목록 깜빡임 방지)
      if (ctx?.optimisticId) {
        setPinnedSessions((prev) => {
          const next = { ...prev }
          delete next[ctx.optimisticId]
          return next
        })
      }

      upsertSessionAtFront(newSession, ctx?.optimisticId)
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previousSessions) {
        queryClient.setQueryData(['sessions'], ctx.previousSessions)
      }
      if (ctx?.optimisticId) {
        setPinnedSessions((prev) => {
          const next = { ...prev }
          delete next[ctx.optimisticId]
          return next
        })
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  // 세션 삭제
  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api.deleteSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      if (selectedSessionId === deleteSessionMutation.variables) {
        setSelectedSessionId(null)
        setMessages([])
      }
    },
  })

  return { createSessionMutation, deleteSessionMutation }
}
