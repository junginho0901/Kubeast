import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@/services/api'
import type { Message } from './types'

// AIChat 전용 state container — selectedSession / messages / input 등 9 state +
// messagesEndRef 를 lift. AIChatBody / SessionSidebar / ChatMain / ChatHeader /
// MessagesList 가 useAIChat() 으로 직접 접근, AIChat root 는 Provider wrap 만.
//
// 주의: setter 의 함수 identity 가 매 render 마다 같도록 useState 의 setter 를
// 그대로 노출. value 객체 자체는 매 render 마다 새로 만들어지지만 (메모이제이션
// 안 함) AIChat 페이지 안에서만 쓰이고 consumer 수가 적어 부담 적음.

interface AIChatContextValue {
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
  messagesEndRef: React.RefObject<HTMLDivElement>
}

const AIChatContext = createContext<AIChatContextValue | null>(null)

export function AIChatProvider({ children }: { children: ReactNode }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [viewSessionId, setViewSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [stoppedSessionId, setStoppedSessionId] = useState<string | null>(null)
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [lastLoadedSessionId, setLastLoadedSessionId] = useState<string | null>(null)
  const [pendingFinalSyncSessionId, setPendingFinalSyncSessionId] = useState<string | null>(null)
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, Session>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const value: AIChatContextValue = {
    selectedSessionId, setSelectedSessionId,
    viewSessionId, setViewSessionId,
    messages, setMessages,
    input, setInput,
    stoppedSessionId, setStoppedSessionId,
    isMultiSelectMode, setIsMultiSelectMode,
    selectedSessionIds, setSelectedSessionIds,
    lastLoadedSessionId, setLastLoadedSessionId,
    pendingFinalSyncSessionId, setPendingFinalSyncSessionId,
    pinnedSessions, setPinnedSessions,
    messagesEndRef,
  }

  return <AIChatContext.Provider value={value}>{children}</AIChatContext.Provider>
}

export function useAIChat(): AIChatContextValue {
  const ctx = useContext(AIChatContext)
  if (!ctx) throw new Error('useAIChat must be used within AIChatProvider')
  return ctx
}
