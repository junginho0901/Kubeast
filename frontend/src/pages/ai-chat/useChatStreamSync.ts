// streaming 중 chatStreamManager 상태를 messages UI 에 반영하는 hook.
// AIChat.tsx 의 useEffect 추출 (Phase 3.2.d).
//
// 현재 선택된 세션이 스트리밍 중이면 임시 assistant 메시지를 갱신하거나 새로
// 추가. user 메시지가 prev 에 없으면 streamState.userMessage 도 추가.
// DB sync (sessionDetail useEffect) 와는 별개 — 그건 부모에 그대로 둠.
//
// 위험도: 중간. setMessages 콜백 의존성 정확히 매칭 필요. e2e ai-chat.spec
// 의 streaming / Stop 케이스가 회귀 자동 cover.

import { useEffect } from 'react'

import type { ChatStreamState } from '@/services/chatStreamManager'

interface Message {
  role: 'user' | 'assistant'
  content: string
  isTemporary?: boolean
  toolCalls?: any[]
  streamingPhase?: any
  [key: string]: any
}

interface Args {
  streamState: ChatStreamState
  selectedSessionId: string | null
  viewSessionId: string | null
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

export function useChatStreamSync({
  streamState,
  selectedSessionId,
  viewSessionId,
  setMessages,
}: Args) {
  useEffect(() => {
    if (streamState.status !== 'streaming') return
    if (!streamState.sessionId) return
    if (selectedSessionId !== streamState.sessionId) return
    if (viewSessionId !== selectedSessionId) return

    setMessages((prev) => {
      const tempAssistantIndex = prev.findIndex((msg) => msg.role === 'assistant' && msg.isTemporary)

      if (tempAssistantIndex !== -1) {
        const updated = [...prev]
        updated[tempAssistantIndex] = {
          ...updated[tempAssistantIndex],
          content: streamState.content,
          toolCalls: streamState.toolCalls && streamState.toolCalls.length > 0 ? [...streamState.toolCalls] : undefined,
          streamingPhase: streamState.streamingPhase ?? updated[tempAssistantIndex].streamingPhase,
        }
        return updated
      }

      // DB에는 아직 assistant 메시지가 없을 수 있으므로, 임시 assistant 메시지를 추가한다.
      const nextMessages = [...prev]
      if (!nextMessages.some((m) => m.role === 'user') && streamState.userMessage) {
        nextMessages.push({
          role: 'user',
          content: streamState.userMessage,
          isTemporary: true,
        })
      }
      nextMessages.push({
        role: 'assistant',
        content: streamState.content,
        isTemporary: true,
        toolCalls: streamState.toolCalls && streamState.toolCalls.length > 0 ? [...streamState.toolCalls] : undefined,
        streamingPhase: streamState.streamingPhase ?? 'waiting',
      })
      return nextMessages
    })
  }, [selectedSessionId, streamState, viewSessionId, setMessages])
}
