import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { ChatStreamState } from '@/services/chatStreamManager'
import type { Message } from '../types'

// streaming → streaming 외 상태 전환을 감지해 후속 동기화를 수행한다.
// - sessions / session 상세 invalidate (sidebar 의 마지막 활동 시각 등)
// - completed: pendingFinalSyncSessionId 세팅해서 useSessionDetailSync 가 최종 동기화하도록
// - 임시 말풍선 isTemporary=false 로 영구 전환
// - error: i18n 한 에러 말풍선 1개 추가

interface Params {
  streamState: ChatStreamState
  selectedSessionId: string | null
  setPendingFinalSyncSessionId: (id: string | null) => void
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  t: TFunction
}

export function useStreamEndSync({
  streamState,
  selectedSessionId,
  setPendingFinalSyncSessionId,
  setMessages,
  t,
}: Params) {
  const queryClient = useQueryClient()
  const prevStreamStatusRef = useRef(streamState.status)

  useEffect(() => {
    const prev = prevStreamStatusRef.current
    const next = streamState.status
    prevStreamStatusRef.current = next

    if (prev !== 'streaming' || next === 'streaming') return

    queryClient.invalidateQueries({ queryKey: ['sessions'] })
    if (streamState.sessionId) {
      queryClient.refetchQueries({ queryKey: ['session', streamState.sessionId] })
    }

    if (next === 'completed' && streamState.sessionId) {
      setPendingFinalSyncSessionId(streamState.sessionId)
    }

    setMessages((prevMessages) =>
      prevMessages.map((m) => ({ ...m, isTemporary: false })),
    )

    if (next === 'error' && streamState.error && streamState.sessionId && selectedSessionId === streamState.sessionId) {
      setMessages((prevMessages) => [
        ...prevMessages,
        { role: 'assistant', content: t('aiChat.errorAnswer', { error: streamState.error }) },
      ])
    }
  }, [queryClient, selectedSessionId, streamState.error, streamState.sessionId, streamState.status,
      setPendingFinalSyncSessionId, setMessages, t])
}
