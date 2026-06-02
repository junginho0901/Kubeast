import { useEffect, useRef, useState } from 'react'
import { chatStreamManager, ChatStreamState } from '@/services/chatStreamManager'
import type { Message } from '../types'

// 전역 chatStreamManager 구독 + 두 ref (streamStateRef / messagesRef) 관리.
// 라우트 이동(언마운트) 이후에도 manager 가 살아있으므로 매 mount 마다 새로
// subscribe 하고 cleanup 에서 unsubscribe.
//
// messagesRef 는 useSessionDetailSync 가 동기 시점에 "UI 가 가진 메시지" 를
// 읽기 위해 필요. messages 가 바뀔 때마다 ref 도 같이 갱신.

interface Params {
  messages: Message[]
}

interface Result {
  streamState: ChatStreamState
  streamStateRef: React.MutableRefObject<ChatStreamState>
  messagesRef: React.MutableRefObject<Message[]>
}

export function useChatStreamState({ messages }: Params): Result {
  const [streamState, setStreamState] = useState<ChatStreamState>(() => chatStreamManager.getState())
  const streamStateRef = useRef<ChatStreamState>(streamState)
  const messagesRef = useRef<Message[]>([])

  useEffect(() => {
    const unsubscribe = chatStreamManager.subscribe((s) => {
      streamStateRef.current = s
      setStreamState(s)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  return { streamState, streamStateRef, messagesRef }
}
