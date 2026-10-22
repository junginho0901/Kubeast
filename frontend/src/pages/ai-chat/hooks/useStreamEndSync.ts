import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { ChatStreamState } from '@/services/chatStreamManager'
import { chatErrorText } from '@/utils/chatError'
import type { Message } from '../types'

// streaming → streaming 외 상태 전환을 감지해 후속 동기화를 수행한다.
// - sessions / session 상세 invalidate (sidebar 의 마지막 활동 시각 등)
// - completed: pendingFinalSyncSessionId 세팅해서 useSessionDetailSync 가 최종 동기화하도록
// - 임시 말풍선 isTemporary=false 로 영구 전환
// - error: i18n 한 에러 말풍선 1개 추가

// The turn's temporary bubbles become permanent; after an error, the assistant placeholder that never got any
// text or tool call is dropped (it would stay as an empty "…" bubble above the error answer).
export function settleMessages(messages: Message[], errored: boolean): Message[] {
  return messages
    .filter((m) => !(errored && m.isTemporary && m.role === 'assistant' && !m.content && !m.toolCalls?.length))
    .map((m) => ({ ...m, isTemporary: false }))
}

// The answer the user stopped: the last assistant bubble carries the stopped marker the server saves with it, so its
// usage line reads "Stopped · usage not available" now and after a reload. Stopped before any text or tool call,
// nothing is saved, so its empty placeholder goes too (it would stay as a "…" bubble that looks still busy).
export function markStoppedAnswer(messages: Message[]): Message[] {
  const last = messages.map((m) => m.role).lastIndexOf('assistant')
  if (last < 0) return messages
  if (!messages[last].content) {
    return last === messages.length - 1 && !messages[last].toolCalls?.length ? messages.slice(0, last) : messages
  }
  return messages.map((m, i) => (i === last ? { ...m, usage: { stopped: true } } : m))
}

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

    setMessages((prevMessages) => settleMessages(prevMessages, next === 'error'))

    if (next === 'error' && streamState.error && streamState.sessionId && selectedSessionId === streamState.sessionId) {
      const content = streamState.errorKey
        ? chatErrorText(t, streamState.error, streamState.errorKey, streamState.errorArgs)
        : t('aiChat.errorAnswer', { error: streamState.error })
      setMessages((prevMessages) => [...prevMessages, { role: 'assistant', content }])
    }
  }, [queryClient, selectedSessionId, streamState.error, streamState.errorKey, streamState.errorArgs, streamState.sessionId, streamState.status,
      setPendingFinalSyncSessionId, setMessages, t])
}
