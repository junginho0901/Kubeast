import { useRef, useState, type ReactNode } from 'react'
import type { Session } from '@/services/api'
import type { Message } from './types'
import { AIChatContext, type AIChatContextValue } from './AIChatContext'

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
