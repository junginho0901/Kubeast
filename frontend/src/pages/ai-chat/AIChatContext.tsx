import { createContext, useContext } from 'react'
import type { Session } from '@/services/api'
import type { Message } from './types'

// AIChat 전용 state container — selectedSession / messages / input 등 9 state +
// messagesEndRef 를 lift. AIChatBody / SessionSidebar / ChatMain / ChatHeader /
// MessagesList 가 useAIChat() 으로 직접 접근, AIChat root 는 Provider wrap 만.
//
// 주의: setter 의 함수 identity 가 매 render 마다 같도록 useState 의 setter 를
// 그대로 노출. value 객체 자체는 매 render 마다 새로 만들어지지만 (메모이제이션
// 안 함) AIChat 페이지 안에서만 쓰이고 consumer 수가 적어 부담 적음.

export interface AIChatContextValue {
  selectedSessionId: string | null
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>
  viewSessionId: string | null
  setViewSessionId: React.Dispatch<React.SetStateAction<string | null>>
  messages: Message[]
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  input: string
  setInput: (s: string) => void
  stoppedSessionId: string | null
  setStoppedSessionId: (id: string | null) => void
  isMultiSelectMode: boolean
  setIsMultiSelectMode: (b: boolean) => void
  selectedSessionIds: Set<string>
  setSelectedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>
  lastLoadedSessionId: string | null
  setLastLoadedSessionId: (id: string | null) => void
  pendingFinalSyncSessionId: string | null
  setPendingFinalSyncSessionId: (id: string | null) => void
  pinnedSessions: Record<string, Session>
  setPinnedSessions: React.Dispatch<React.SetStateAction<Record<string, Session>>>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
}

export const AIChatContext = createContext<AIChatContextValue | null>(null)

export function useAIChat(): AIChatContextValue {
  const ctx = useContext(AIChatContext)
  if (!ctx) throw new Error('useAIChat must be used within AIChatProvider')
  return ctx
}
