import { useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { Session } from '@/services/api'
import { chatStreamManager, ChatStreamState } from '@/services/chatStreamManager'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import type { Message } from '../types'

// AIChat 의 메인 핸들러 swarm: send / stop / new chat / select / delete /
// multi-select 토글 / 일괄 삭제 / select all / deselect all.
//
// handleSend / handleStop 이 가장 무거움. handleSend 는 optimistic session 생성
// (첫 질문에서 UI 깜빡임 제거) 까지 한 함수에서 처리.

const isTempSessionId = (id: string | null) => typeof id === 'string' && id.startsWith('temp:')

interface Params {
  input: string
  setInput: (s: string) => void
  selectedSessionId: string | null
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>
  setViewSessionId: React.Dispatch<React.SetStateAction<string | null>>
  setStoppedSessionId: (id: string | null) => void
  setPendingFinalSyncSessionId: (id: string | null) => void
  pinnedSessions: Record<string, Session>
  setPinnedSessions: React.Dispatch<React.SetStateAction<Record<string, Session>>>
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  isMultiSelectMode: boolean
  setIsMultiSelectMode: (b: boolean) => void
  selectedSessionIds: Set<string>
  setSelectedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>
  sessionsList: Session[]
  streamState: ChatStreamState
  isStreaming: boolean
  upsertSessionAtFront: (s: Session, oldId?: string) => void
  createSessionMutation: UseMutationResult<Session, Error, { title: string; optimisticId: string }, { previousSessions: any; optimisticId: string } | undefined>
  deleteSessionMutation: UseMutationResult<unknown, Error, string, unknown>
  t: TFunction
}

export function useChatHandlers({
  input,
  setInput,
  selectedSessionId,
  setSelectedSessionId,
  setViewSessionId,
  setStoppedSessionId,
  setPendingFinalSyncSessionId,
  pinnedSessions: _pinnedSessions,
  setPinnedSessions,
  setMessages,
  isMultiSelectMode,
  setIsMultiSelectMode,
  selectedSessionIds,
  setSelectedSessionIds,
  sessionsList,
  streamState,
  isStreaming,
  upsertSessionAtFront,
  createSessionMutation,
  deleteSessionMutation,
  t,
}: Params) {
  const queryClient = useQueryClient()

  const handleStop = async () => {
    const snapshot = chatStreamManager.getState()
    if (!snapshot.sessionId || !snapshot.isStreaming) return

    console.log('[DEBUG] Stop button clicked. sessionId=', snapshot.sessionId)

    // 중단된 세션은 현재 UI 상태를 유지하기 위해 DB 동기화를 잠시 막는다.
    setStoppedSessionId(snapshot.sessionId)

    await chatStreamManager.stop()

    const assistantContent = snapshot.functionCallsContent + snapshot.assistantContent
    if (assistantContent) {
      try {
        // DB에 중단된 assistant 메시지만 저장 (user 메시지는 백엔드에서 이미 저장)
        console.log('[DEBUG] Saving stopped assistant message to DB')
        const response = await fetch(`/api/v1/sessions/${snapshot.sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            messages: [
              {
                role: 'assistant',
                content: assistantContent,
                tool_calls: snapshot.toolCalls && snapshot.toolCalls.length > 0 ? snapshot.toolCalls : undefined,
              },
            ],
          }),
        })

        if (response.status === 401) {
          handleUnauthorized()
          return
        }

        if (response.ok) {
          console.log('[DEBUG] Messages saved successfully')
          await queryClient.refetchQueries({ queryKey: ['session', snapshot.sessionId] })
          await queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      } catch (error) {
        console.error('[ERROR] Failed to save stopped messages:', error)
      }
    }

    // 임시 플래그 제거하여 현재 화면에 유지
    setMessages((prev) => prev.map((msg) => ({ ...msg, isTemporary: false })))
  }

  const handleSend = async (messageToSend?: string) => {
    const message = messageToSend || input.trim()
    if (!message || isStreaming) return

    const userMessage = message
    const initialTitle = userMessage.length > 50 ? `${userMessage.slice(0, 50)}...` : userMessage

    setStoppedSessionId(null)
    setPendingFinalSyncSessionId(null)

    const existingRealSessionId =
      selectedSessionId && !isTempSessionId(selectedSessionId) ? selectedSessionId : null

    const optimisticId =
      existingRealSessionId ?? `temp:${Date.now()}-${Math.random().toString(16).slice(2)}`

    if (!existingRealSessionId) {
      setSelectedSessionId(optimisticId)
      setViewSessionId(optimisticId)

      // 세션 목록이 아직 로딩 중이어도, 임시 세션을 즉시 목록에 노출
      const nowIso = new Date().toISOString()
      const optimisticSession: Session = {
        id: optimisticId,
        title: initialTitle || t('aiChat.newChatTitle'),
        created_at: nowIso,
        updated_at: nowIso,
        message_count: 0,
      }
      setPinnedSessions((prev) => ({ ...prev, [optimisticId]: optimisticSession }))
      upsertSessionAtFront(optimisticSession)
    }
    if (existingRealSessionId) {
      setViewSessionId(existingRealSessionId)
    }

    const newMessage: Message = {
      role: 'user',
      content: userMessage,
      isTemporary: true,
    }

    setMessages((prev) => [
      ...prev,
      newMessage,
      { role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting' },
    ])
    setInput('')

    const startStream = (sessionIdToUse: string) => {
      void chatStreamManager.startSessionChat(sessionIdToUse, userMessage).catch((error) => {
        console.error('[ERROR] Failed to start streaming:', error)
        setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: t('aiChat.errorAnswer', { error: String(error) }) },
        ])
      })
    }

    if (existingRealSessionId) {
      startStream(existingRealSessionId)
      return
    }

    // 중요: 여기서 await 하면 React 18 batching 때문에 "대화방/말풍선 표시"가
    // 네트워크 응답까지 지연될 수 있어 mutate + callback 으로 분리한다.
    createSessionMutation.mutate(
      { title: initialTitle, optimisticId },
      {
        onSuccess: (newSession) => {
          startStream(newSession.id)
          setSelectedSessionId((current: string | null) => (current === optimisticId ? newSession.id : current))
          setViewSessionId((current: string | null) => (current === optimisticId ? newSession.id : current))
        },
        onError: (error) => {
          console.error('[ERROR] Failed to create session:', error)
          setSelectedSessionId((current: string | null) => (current === optimisticId ? null : current))
          setViewSessionId((current: string | null) => (current === optimisticId ? null : current))
          setPinnedSessions((prev) => {
            const next = { ...prev }
            delete next[optimisticId]
            return next
          })
          setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: t('aiChat.errorSessionCreate', { error: String(error) }) },
          ])
        },
      },
    )
  }

  const handleNewChat = () => {
    // 세션을 미리 생성하지 않고, 선택만 해제 (첫 질문 시 자동 생성)
    setSelectedSessionId(null)
    setViewSessionId(null)
    setStoppedSessionId(null)
    setPendingFinalSyncSessionId(null)
    setPinnedSessions({})
    setMessages([])
  }

  const handleSelectSession = (sessionId: string) => {
    if (isMultiSelectMode) {
      const newSelected = new Set(selectedSessionIds)
      if (newSelected.has(sessionId)) {
        newSelected.delete(sessionId)
      } else {
        newSelected.add(sessionId)
      }
      setSelectedSessionIds(newSelected)
    } else {
      // 같은 세션 재클릭 시 무시 — setSelectedSessionId(같은 값) 은 useQuery 재실행
      // 안 시키는데 setMessages([]) 만 실행되어 영원히 빈 화면이 되는 버그 방지.
      if (selectedSessionId === sessionId) return

      setSelectedSessionId(sessionId)
      setViewSessionId(sessionId)
      setStoppedSessionId(null)
      setPendingFinalSyncSessionId(null)
      setMessages([])
    }
  }

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const isStreamingThisSession = isStreaming && streamState.sessionId === sessionId

    const ok = isStreamingThisSession
      ? confirm(t('aiChat.confirmDeleteStreaming'))
      : confirm(t('aiChat.confirmDelete'))

    if (!ok) return

    if (isStreamingThisSession) {
      await chatStreamManager.stop()
    }

    setStoppedSessionId(null)
    setPendingFinalSyncSessionId(null)
    setPinnedSessions((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null)
      setViewSessionId(null)
      setMessages([])
    }
    deleteSessionMutation.mutate(sessionId)
  }

  const handleToggleMultiSelect = () => {
    setIsMultiSelectMode(!isMultiSelectMode)
    setSelectedSessionIds(new Set())
  }

  const handleDeleteSelected = async () => {
    if (selectedSessionIds.size === 0) return

    const includesStreaming =
      isStreaming && !!streamState.sessionId && selectedSessionIds.has(streamState.sessionId)

    const ok = includesStreaming
      ? confirm(
          t('aiChat.confirmDeleteSelectedWithStreaming', { count: selectedSessionIds.size }),
        )
      : confirm(t('aiChat.confirmDeleteSelected', { count: selectedSessionIds.size }))

    if (ok) {
      if (includesStreaming) {
        await chatStreamManager.stop()
      }

      for (const sessionId of selectedSessionIds) {
        if (isTempSessionId(sessionId)) continue
        await deleteSessionMutation.mutateAsync(sessionId)
      }

      setSelectedSessionIds(new Set())
      setIsMultiSelectMode(false)

      if (selectedSessionId && selectedSessionIds.has(selectedSessionId)) {
        setSelectedSessionId(null)
        setViewSessionId(null)
        setStoppedSessionId(null)
        setPendingFinalSyncSessionId(null)
        setPinnedSessions({})
        setMessages([])
      }
    }
  }

  const handleSelectAll = () => {
    if (sessionsList.length > 0) {
      setSelectedSessionIds(new Set(sessionsList.map((s) => s.id).filter((id) => !isTempSessionId(id))))
    }
  }

  const handleDeselectAll = () => {
    setSelectedSessionIds(new Set())
  }

  return {
    handleStop,
    handleSend,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    handleToggleMultiSelect,
    handleDeleteSelected,
    handleSelectAll,
    handleDeselectAll,
  }
}

