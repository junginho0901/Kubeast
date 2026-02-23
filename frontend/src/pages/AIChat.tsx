import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { api, Session } from '@/services/api'
import { chatStreamManager, ChatStreamState } from '@/services/chatStreamManager'
import ParticleWaveLoader from '@/components/ParticleWaveLoader'
import { Send, Bot, User, Sparkles, Plus, MessageSquare, Trash2, Edit2, Check, X, StopCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import JSZip from 'jszip'

const TOOL_RESULT_DISPLAY_MAX_CHARS = 2000
const TRUNCATED_MARKER = '... (truncated) ...'
const SESSIONS_PAGE_SIZE = 50

const hasTruncatedToolCalls = (toolCalls?: any[]) => {
  if (!Array.isArray(toolCalls)) return false
  return toolCalls.some((tc) => {
    if (!tc) return false
    const result = typeof tc.result === 'string' ? tc.result : ''
    const display = typeof tc.display === 'string' ? tc.display : ''
    return result.includes(TRUNCATED_MARKER) || display.includes(TRUNCATED_MARKER)
  })
}

function truncateToolResultsInContent(content: string, maxChars = TOOL_RESULT_DISPLAY_MAX_CHARS) {
  if (!content) return content

  // Only truncate tool "📊 Results" blocks. Keep other code blocks intact.
  const resultsBlockRegex =
    /(<summary><strong>📊 Results<\/strong><\/summary>[\s\S]*?```(?:json|yaml)?\r?\n)([\s\S]*?)(\r?\n```)/g

  return content.replace(resultsBlockRegex, (_match, prefix: string, body: string, suffix: string) => {
    if (body.includes(TRUNCATED_MARKER)) return `${prefix}${body}${suffix}`
    if (body.length <= maxChars) return `${prefix}${body}${suffix}`
    const truncatedBody = body.slice(0, maxChars) + `\n${TRUNCATED_MARKER}`
    return `${prefix}${truncatedBody}${suffix}`
  })
}

interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
  isTemporary?: boolean  // 스트리밍 중 임시 메시지 표시
  // Tool 호출 결과 (DB의 tool_calls 컬럼 그대로)
  toolCalls?: any[] 
  // 스트리밍 단계(툴 실행/답변 생성 구분). 임시 메시지에서만 사용.
  streamingPhase?: 'waiting' | 'tools' | 'answer'
}

type SessionsPageParam = {
  before_updated_at?: string
  before_id?: string
}

export default function AIChat() {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [viewSessionId, setViewSessionId] = useState<string | null>(null) // 현재 화면에 표시 중인 메시지의 세션
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streamState, setStreamState] = useState<ChatStreamState>(() => chatStreamManager.getState())
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [stoppedSessionId, setStoppedSessionId] = useState<string | null>(null)  // 중단된 세션 ID
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false)  // 다중 선택 모드
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())  // 선택된 세션들
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)  // 우클릭 컨텍스트 메뉴
  const [lastLoadedSessionId, setLastLoadedSessionId] = useState<string | null>(null)
  const [pendingFinalSyncSessionId, setPendingFinalSyncSessionId] = useState<string | null>(null)
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, Session>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamStateRef = useRef<ChatStreamState>(streamState)
  const messagesRef = useRef<Message[]>([])
  const finalSyncRetryRef = useRef<{ sessionId: string | null; tries: number }>({
    sessionId: null,
    tries: 0,
  })
  const finalSyncTimerRef = useRef<number | null>(null)
  const sessionsScrollRef = useRef<HTMLDivElement>(null)
  const sessionsScrollRafRef = useRef<number | null>(null)
  const [sessionsScrollTop, setSessionsScrollTop] = useState(0)
  const [sessionsViewportHeight, setSessionsViewportHeight] = useState(0)

  const isStreaming = streamState.isStreaming
  const isTempSessionId = (id: string | null) => typeof id === 'string' && id.startsWith('temp:')

  // 세션 목록 조회
  const {
    data: sessionsInfinite,
    isLoading: sessionsLoading,
    isFetchingNextPage: sessionsFetchingNextPage,
    fetchNextPage: fetchNextSessionsPage,
    hasNextPage: sessionsHasNextPage,
  } = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => api.getSessions({ limit: SESSIONS_PAGE_SIZE, ...(pageParam || {}) }),
    initialPageParam: {} as SessionsPageParam,
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage)) return undefined
      if (lastPage.length < SESSIONS_PAGE_SIZE) return undefined
      const last = lastPage[lastPage.length - 1]
      if (!last) return undefined
      return { before_updated_at: last.updated_at, before_id: last.id } as SessionsPageParam
    },
  })

  const getFlattenedSessions = (data?: InfiniteData<Session[]>) => {
    const pages = data?.pages
    if (!pages || !Array.isArray(pages)) return []
    const seen = new Set<string>()
    const result: Session[] = []
    for (const page of pages) {
      if (!Array.isArray(page)) continue
      for (const session of page) {
        if (!session) continue
        if (seen.has(session.id)) continue
        seen.add(session.id)
        result.push(session)
      }
    }
    return result
  }

  const buildSessionsInfiniteData = (sessions: Session[]): InfiniteData<Session[]> => {
    const pages: Session[][] = []
    for (let i = 0; i < sessions.length; i += SESSIONS_PAGE_SIZE) {
      pages.push(sessions.slice(i, i + SESSIONS_PAGE_SIZE))
    }

    const pageParams: Array<SessionsPageParam | undefined> = []
    let cursor: SessionsPageParam | undefined = {} as SessionsPageParam
    for (const page of pages) {
      pageParams.push(cursor)
      if (page.length > 0) {
        const last = page[page.length - 1]
        cursor = last ? { before_updated_at: last.updated_at, before_id: last.id } : cursor
      }
    }

    return {
      pages: pages.length > 0 ? pages : [[]],
      pageParams,
    }
  }

  const upsertSessionAtFront = (session: Session, optimisticId?: string | null) => {
    queryClient.setQueryData<InfiniteData<Session[]>>(['sessions'], (old) => {
      const existing = getFlattenedSessions(old)
      const withoutDuplicates = existing.filter((s) => s.id !== session.id && (!optimisticId || s.id !== optimisticId))
      return buildSessionsInfiniteData([session, ...withoutDuplicates])
    })
  }

  const sessionsList = useMemo(() => {
    const base = getFlattenedSessions(sessionsInfinite)
    const baseById = new Map(base.map((s) => [s.id, s] as const))
    // pinnedSessions는 "temp:" 세션 등 서버 목록에 아직 없는 항목을 잠깐 노출하기 위한 용도.
    // 서버에서 동일 ID가 내려오면(=실제 세션이 존재) 서버 데이터를 우선한다.
    const pinnedVisible = Object.values(pinnedSessions).filter((s) => isTempSessionId(s.id) || !baseById.has(s.id))
    const pinnedIds = new Set(pinnedVisible.map((s) => s.id))
    return [...pinnedVisible, ...base.filter((s) => !pinnedIds.has(s.id))]
  }, [pinnedSessions, sessionsInfinite])

  useEffect(() => {
    const el = sessionsScrollRef.current
    if (!el) return

    const update = () => {
      setSessionsViewportHeight(el.clientHeight || 0)
      setSessionsScrollTop(el.scrollTop || 0)
    }

    update()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 세션 상세 조회 (스트리밍 중이 아닐 때만)
  const { data: sessionDetail } = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => api.getSession(selectedSessionId!),
    enabled: !!selectedSessionId && !isTempSessionId(selectedSessionId),
  })

  // AI 설정 정보 조회 (모델명)
  const { data: aiConfig } = useQuery({
    queryKey: ['ai-config'],
    queryFn: api.getAIConfig,
    staleTime: Infinity, // 설정은 변경되지 않으므로 캐시 무한정 유지
  })

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

  // 세션 제목 수정
  const updateSessionMutation = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.updateSession(sessionId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setEditingSessionId(null)
    },
  })

  // 세션 상세가 로드되면 메시지 설정
  // - 새 세션으로 전환될 때는 DB 내용을 그대로 사용
  // - 동일 세션에서 스트리밍이 끝난 후에는, 이미 화면에 있는 답변을 덮어쓰지 않도록 함
  useEffect(() => {
    if (sessionDetail && stoppedSessionId !== sessionDetail.id) {
      console.log('[DEBUG] Loading messages from DB:', sessionDetail.messages.length, 'messages')
      
      const dbMessages = sessionDetail.messages.map((msg) => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        toolCalls: msg.tool_calls || undefined,
      }))

      // 스트리밍 직후(DB에 assistant가 아직 저장되기 전)에는 DB가 뒤처진 상태로 UI를 덮어쓰지 않도록 방어
      const uiSnapshot = messagesRef.current
      const uiHasAssistant = uiSnapshot.some((m) => m.role === 'assistant' && (m.content?.length ?? 0) > 0)
      const dbIsBehind = dbMessages.length < uiSnapshot.length
      const activeStream = streamStateRef.current
      const streamRelatedToThisSession =
        activeStream.sessionId === sessionDetail.id && (activeStream.status === 'streaming' || activeStream.status === 'completed')

      // 1) 세션이 바뀐 경우: DB 데이터로 완전히 교체 (스트리밍 중인 세션이라도 화면 세션은 맞춰야 함)
      if (sessionDetail.id !== lastLoadedSessionId) {
        const uiHasTemporary = messagesRef.current.some((m) => m.isTemporary)
        const streamForThisSession =
          activeStream.sessionId === sessionDetail.id && activeStream.status === 'streaming'

        // 새로 만든 세션으로 전환 직후(session 생성 완료 직후)에는 DB가 잠깐 빈 배열을 줄 수 있음.
        // 이때 UI에 이미 임시 말풍선이 있으면, 빈 DB 데이터로 덮어써서 "초기화면으로 깜빡"하지 않게 한다.
        if (dbMessages.length === 0 && (streamForThisSession || uiHasTemporary)) {
          setLastLoadedSessionId(sessionDetail.id)
          setViewSessionId(sessionDetail.id)
          return
        }

        // DB가 뒤처진 상태(assistant 저장 전)라면, UI에 이미 그려진 말풍선을 유지한다.
        if (streamRelatedToThisSession && uiHasAssistant && dbIsBehind) {
          setLastLoadedSessionId(sessionDetail.id)
          setViewSessionId(sessionDetail.id)
          return
        }

        console.log('[DEBUG] Session changed, replacing messages from DB')
        setMessages(dbMessages)
        setLastLoadedSessionId(sessionDetail.id)
        setViewSessionId(sessionDetail.id)
        return
      }

      // 현재 세션이 스트리밍 중이라면 DB의 중간 상태(user만 저장 등)로 UI를 덮어쓰지 않는다.
      if (activeStream.status === 'streaming' && activeStream.sessionId === sessionDetail.id) {
        return
      }

      // 스트리밍 완료 후: DB에 최종 assistant 메시지가 저장되었을 때만 동기화한다.
      if (pendingFinalSyncSessionId && sessionDetail.id === pendingFinalSyncSessionId) {
        const uiLen = messagesRef.current.length
        const last = dbMessages[dbMessages.length - 1]
        // "assistant로 끝난다"만으로는 부족함(이전 턴까지만 있어도 assistant로 끝날 수 있음).
        // 최소한 UI가 가진 메시지 수만큼 DB에 반영된 이후에만 동기화한다.
        if (last && last.role === 'assistant' && dbMessages.length >= uiLen) {
          setMessages(dbMessages)
          setLastLoadedSessionId(sessionDetail.id)
          setPendingFinalSyncSessionId(null)
          setViewSessionId(sessionDetail.id)
          return
        }

        // 아직 DB에 최종 assistant가 반영되지 않았으면 짧게 재조회(몇 번만)해서 동기화 기회를 만든다.
        // (그 사이 UI는 유지)
        if (finalSyncRetryRef.current.sessionId !== pendingFinalSyncSessionId) {
          finalSyncRetryRef.current = { sessionId: pendingFinalSyncSessionId, tries: 0 }
        }
        if (finalSyncTimerRef.current != null) {
          clearTimeout(finalSyncTimerRef.current)
          finalSyncTimerRef.current = null
        }
        if (finalSyncRetryRef.current.tries < 8) {
          finalSyncRetryRef.current.tries += 1
          finalSyncTimerRef.current = window.setTimeout(() => {
            void queryClient.refetchQueries({ queryKey: ['session', pendingFinalSyncSessionId] })
          }, 500)
        }
      }

      // 2) 같은 세션인 경우:
      //    - 아직 화면에 영구 메시지가 없으면(DB 초기 로드 등) DB로 교체
      //    - 이미 user/assistant 메시지가 있으면 그대로 유지 (스트리밍 완료 후 덮어쓰지 않음)
      setMessages((prev) => {
        // DB가 뒤처진 상태면(예: assistant 저장 전) 현재 UI를 유지한다.
        if (uiHasAssistant && dbMessages.length < prev.length) {
          return prev
        }
        const hasNonTemporary = prev.some(msg => !msg.isTemporary)
        if (!hasNonTemporary) {
          console.log('[DEBUG] No non-temporary messages yet, syncing from DB')
          setViewSessionId(sessionDetail.id)
          return dbMessages
        }
        console.log('[DEBUG] Keeping existing messages (same session, non-temporary present)')
        return prev
      })
    }
  }, [pendingFinalSyncSessionId, sessionDetail, stoppedSessionId, lastLoadedSessionId, queryClient])

  // 컴포넌트 언마운트 시 final sync 타이머 정리
  useEffect(() => {
    return () => {
      if (finalSyncTimerRef.current != null) {
        clearTimeout(finalSyncTimerRef.current)
        finalSyncTimerRef.current = null
      }
    }
  }, [])

  // 스트리밍 상태는 라우트 이동(언마운트) 이후에도 유지될 수 있으므로,
  // 전역 스트림 매니저에서 상태를 구독한다.
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

  // 현재 선택된 세션이 스트리밍 중인 세션이라면, 스트리밍 내용을 UI에 반영
  useEffect(() => {
    if (streamState.status !== 'streaming') return
    if (!streamState.sessionId) return
    if (selectedSessionId !== streamState.sessionId) return
    if (viewSessionId !== selectedSessionId) return

    const combinedContent = streamState.functionCallsContent + streamState.assistantContent

    setMessages((prev) => {
      const tempAssistantIndex = prev.findIndex((msg) => msg.role === 'assistant' && msg.isTemporary)

      if (tempAssistantIndex !== -1) {
        const updated = [...prev]
        updated[tempAssistantIndex] = {
          ...updated[tempAssistantIndex],
          content: combinedContent,
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
        content: combinedContent,
        isTemporary: true,
        toolCalls: streamState.toolCalls && streamState.toolCalls.length > 0 ? [...streamState.toolCalls] : undefined,
        streamingPhase: streamState.streamingPhase ?? 'waiting',
      })
      return nextMessages
    })
  }, [selectedSessionId, streamState, viewSessionId])

  // 스트리밍 종료 시(완료/오류/중단) 세션 목록/상세를 갱신하고 임시 플래그를 정리
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

    // 현재 화면에 보이는 임시 메시지는 일단 영구 표시로 전환
    setMessages((prevMessages) =>
      prevMessages.map((m) => ({
        ...m,
        isTemporary: false,
      }))
    )

    if (next === 'error' && streamState.error && streamState.sessionId && selectedSessionId === streamState.sessionId) {
      setMessages((prevMessages) => [
        ...prevMessages,
        { role: 'assistant', content: `죄송합니다. 답변을 생성하는 중 오류가 발생했습니다: ${streamState.error}` },
      ])
    }
  }, [queryClient, selectedSessionId, streamState.error, streamState.sessionId, streamState.status])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(scrollToBottom, [messages])

  // 외부 클릭 시 컨텍스트 메뉴 닫기
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) {
        setContextMenu(null)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [contextMenu])

  // ESC 키로 컨텍스트 메뉴 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && contextMenu) {
        setContextMenu(null)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

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

    // 중단 플래그 리셋
    setStoppedSessionId(null)
    setPendingFinalSyncSessionId(null)

    // 세션이 없으면(첫 질문) UI는 즉시 보여주고, 실제 세션 생성/스트리밍은 비동기로 이어서 처리
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
        title: initialTitle || 'New Chat',
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
      isTemporary: true,  // 임시 메시지로 표시
    }

    // user 메시지와 빈 assistant 메시지를 동시에 추가
    setMessages((prev) => [
      ...prev,
      newMessage,
      { role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting' }  // 로딩용 빈 메시지
    ])
    setInput('')

    const startStream = (sessionIdToUse: string) => {
      // 스트리밍 시작 (라우트 이동 후에도 유지)
      void chatStreamManager.startSessionChat(sessionIdToUse, userMessage).catch((error) => {
        console.error('[ERROR] Failed to start streaming:', error)
        setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `죄송합니다. 답변을 생성하는 중 오류가 발생했습니다: ${String(error)}` },
        ])
      })
    }

    if (existingRealSessionId) {
      startStream(existingRealSessionId)
      return
    }

    // 중요: 여기서 await 하면 React 18 batching 때문에 "대화방/말풍선 표시"가 네트워크 응답까지 지연될 수 있어
    // mutate + callback으로 비동기 작업을 분리한다.
    createSessionMutation.mutate(
      { title: initialTitle, optimisticId },
      {
        onSuccess: (newSession) => {
          // DB 동기화가 중간 상태로 덮어쓰지 않도록 먼저 스트리밍 상태를 올린다.
          startStream(newSession.id)

          // 사용자가 아직 이 임시 세션을 보고 있다면 실제 세션으로 전환
          setSelectedSessionId((current) => (current === optimisticId ? newSession.id : current))
          setViewSessionId((current) => (current === optimisticId ? newSession.id : current))
        },
        onError: (error) => {
          console.error('[ERROR] Failed to create session:', error)
          setSelectedSessionId((current) => (current === optimisticId ? null : current))
          setViewSessionId((current) => (current === optimisticId ? null : current))
          setPinnedSessions((prev) => {
            const next = { ...prev }
            delete next[optimisticId]
            return next
          })
          setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: `세션 생성에 실패했습니다: ${String(error)}` },
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

  const maybeFetchMoreSessions = (container: HTMLDivElement) => {
    if (!sessionsHasNextPage) return
    if (sessionsFetchingNextPage) return
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight
    // "바닥에 딱 닿았을 때"만 다음 페이지를 로드 (브라우저 반올림 오차 감안)
    if (remaining <= 1) {
      void fetchNextSessionsPage()
    }
  }

  const handleSessionsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget

    if (sessionsScrollRafRef.current != null) {
      cancelAnimationFrame(sessionsScrollRafRef.current)
    }

    sessionsScrollRafRef.current = requestAnimationFrame(() => {
      setSessionsScrollTop(container.scrollTop)
      maybeFetchMoreSessions(container)
      sessionsScrollRafRef.current = null
    })
  }

  const handleSelectSession = (sessionId: string) => {
    if (isMultiSelectMode) {
      // 다중 선택 모드에서는 체크박스 토글
      const newSelected = new Set(selectedSessionIds)
      if (newSelected.has(sessionId)) {
        newSelected.delete(sessionId)
      } else {
        newSelected.add(sessionId)
      }
      setSelectedSessionIds(newSelected)
    } else {
      // 일반 모드에서는 세션 선택 + 중단 플래그 초기화
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
      ? confirm('현재 답변 생성 중입니다. 중단하고 이 대화를 삭제하시겠습니까?')
      : confirm('이 대화를 삭제하시겠습니까?')

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
          `선택한 ${selectedSessionIds.size}개의 대화를 삭제하시겠습니까?\n(현재 답변 생성 중인 대화가 포함되어 있어 중단 후 삭제됩니다.)`,
        )
      : confirm(`선택한 ${selectedSessionIds.size}개의 대화를 삭제하시겠습니까?`)

    if (ok) {
      if (includesStreaming) {
        await chatStreamManager.stop()
      }

      // 선택된 세션들을 순차적으로 삭제
      for (const sessionId of selectedSessionIds) {
        if (isTempSessionId(sessionId)) continue
        await deleteSessionMutation.mutateAsync(sessionId)
      }
      
      // 삭제 후 상태 초기화
      setSelectedSessionIds(new Set())
      setIsMultiSelectMode(false)
      
      // 현재 선택된 세션이 삭제되었으면 초기화
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
      setSelectedSessionIds(new Set(sessionsList.map(s => s.id).filter((id) => !isTempSessionId(id))))
    }
  }

  const handleDeselectAll = () => {
    setSelectedSessionIds(new Set())
  }

  const handleEditSession = (session: Session, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
    setContextMenu(null)
  }

  const handleContextMenu = (session: Session, e: React.MouseEvent) => {
    if (isMultiSelectMode) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sessionId: session.id,
    })
  }

  const handleCloseContextMenu = () => {
    setContextMenu(null)
  }

  const handleSaveEdit = (sessionId: string) => {
    if (editingTitle.trim()) {
      updateSessionMutation.mutate({ sessionId, title: editingTitle })
    }
  }

  const handleCancelEdit = () => {
    setEditingSessionId(null)
    setEditingTitle('')
  }

  const quickQuestions = [
    '현재 메모리 많이 쓰는 파드들 알려줘',
    '현재 노드들 상태 알려줘',
    'kube-system 네임스페이스의 Pod 상태를 확인해줘',
    'okestro-cmp 네임스페이스의 Service 목록을 조회해줘',
  ]

  const handleDownloadJson = async (message: Message) => {
    if (!message.toolCalls || message.toolCalls.length === 0) {
      console.warn('[DEBUG] No toolCalls available for download')
      return
    }

    try {
      const resolveToolCallsForDownload = async () => {
        const current = (message.toolCalls as any[]) || []
        const sessionId = viewSessionId || selectedSessionId
        if (!sessionId) return current

        try {
          const session = await api.getSession(sessionId)
          let dbMessage: any | undefined
          const dbToolMessages = session.messages.filter(
            (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
          )

          if (message.id != null) {
            dbMessage = session.messages.find((m) => m.id === message.id)
          }

          if (!dbMessage) {
            const candidates = dbToolMessages

            const currentFns = current
              .map((tc) => (tc && typeof tc.function === 'string' ? tc.function : ''))
              .filter((f) => f.length > 0)

            if (currentFns.length > 0) {
              // Prefer exact ordered match of tool names
              dbMessage = candidates.find((m) => {
                const fns = (m.tool_calls || []).map((tc: any) => String(tc?.function || '')).filter((f: string) => f)
                return fns.length === currentFns.length && fns.every((f: string, i: number) => f === currentFns[i])
              })
            }

            if (!dbMessage && currentFns.length > 0) {
              // Fallback to set match (unordered)
              const currentSet = new Set(currentFns)
              dbMessage = candidates.find((m) => {
                const fns = (m.tool_calls || []).map((tc: any) => String(tc?.function || '')).filter((f: string) => f)
                if (fns.length !== currentFns.length) return false
                const set = new Set(fns)
                if (set.size !== currentSet.size) return false
                for (const f of set) if (!currentSet.has(f)) return false
                return true
              })
            }

            if (!dbMessage && candidates.length > 0) {
              dbMessage = candidates[candidates.length - 1]
            }
          }

          if (!dbMessage && dbToolMessages.length > 0) {
            const uiToolMessages = messagesRef.current.filter(
              (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
            )
            const uiIndex = uiToolMessages.findIndex((m) => m === message)
            if (uiIndex >= 0 && uiIndex < dbToolMessages.length) {
              dbMessage = dbToolMessages[uiIndex]
            }
          }

          if (!dbMessage && dbToolMessages.length > 0 && message.content) {
            const hint = message.content.trim().slice(0, 200)
            if (hint.length >= 20) {
              dbMessage = dbToolMessages.find(
                (m) => typeof m.content === 'string' && m.content.includes(hint)
              )
            }
          }

          if (!dbMessage && dbToolMessages.length > 0) {
            dbMessage = dbToolMessages[dbToolMessages.length - 1]
          }

          if (dbMessage?.tool_calls?.length) {
            return dbMessage.tool_calls
          }
        } catch (e) {
          console.warn('[WARN] Failed to load tool results from session:', e)
        }

        return current
      }

      let toolCalls = await resolveToolCallsForDownload()

      // If current toolCalls contain truncated markers, try to recover full results from DB
      if (hasTruncatedToolCalls(toolCalls)) {
        const sessionId = viewSessionId || selectedSessionId
        if (sessionId) {
          try {
            const session = await api.getSession(sessionId)
            const candidates = session.messages
              .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
              .reverse()

            const full = candidates.find((m) => !hasTruncatedToolCalls(m.tool_calls))
            if (full?.tool_calls?.length) {
              toolCalls = full.tool_calls
            }
          } catch (e) {
            console.warn('[WARN] Failed to recover full tool results from session:', e)
          }
        }
      }

      if (hasTruncatedToolCalls(toolCalls)) {
        console.warn('[WARN] Downloading truncated tool results (full results not available).')
      }
      const now = new Date()
      const pad = (n: number) => n.toString().padStart(2, '0')
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
        now.getDate()
      )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

      const sanitizeName = (value: string) =>
        value
          .replace(/[^a-zA-Z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'tool'

      const nameCounts = new Map<string, number>()
      const getUniqueBase = (base: string) => {
        const current = nameCounts.get(base) || 0
        const next = current + 1
        nameCounts.set(base, next)
        return next > 1 ? `${base}_${next}` : base
      }

      const buildParamSuffix = (args: any) => {
        if (!args || typeof args !== 'object') return ''
        const parts: string[] = []
        const pushPart = (label: string, value: unknown) => {
          if (value == null) return
          const raw = Array.isArray(value) ? value.join(',') : String(value)
          const trimmed = raw.trim()
          if (!trimmed) return
          const limited = trimmed.length > 40 ? trimmed.slice(0, 40) : trimmed
          parts.push(`${label}-${limited}`)
        }
        pushPart('ns', args.namespace)
        pushPart('type', args.resource_type)
        pushPart('name', args.resource_name)
        pushPart('pod', args.pod_name)
        pushPart('svc', args.service_name)
        pushPart('name', args.name)
        pushPart('out', args.output)
        pushPart('ctr', args.container)
        if (parts.length === 0) return ''
        const joined = parts.slice(0, 4).join('_')
        const safe = sanitizeName(joined).slice(0, 60)
        return safe ? `_${safe}` : ''
      }

      const downloadZip = async (content: Blob, filename: string) => {
        const url = URL.createObjectURL(content)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }

      const zip = new JSZip()

      for (const tc of toolCalls) {
        if (!tc) continue
        const functionName = typeof tc.function === 'string' ? tc.function : 'tool'
        const args = (tc.args || {}) as any
        const isJson = !!tc.is_json
        const isYaml = !!tc.is_yaml
        const isLog = functionName === 'get_pod_logs' || functionName === 'k8s_get_pod_logs'

        let content =
          typeof tc.result === 'string'
            ? String(tc.result)
            : JSON.stringify(tc.result ?? null, null, 2)

        const base = sanitizeName(functionName)
        const uniqueBase = getUniqueBase(base)
        const paramSuffix = buildParamSuffix(args)
        let ext = 'txt'
        if (isLog) {
          ext = 'log'
        } else if (isYaml) {
          ext = 'yaml'
        } else if (isJson) {
          ext = 'json'
        }

        const filename = `${uniqueBase}${paramSuffix}_${timestamp}.${ext}`
        zip.file(filename, content)
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      await downloadZip(zipBlob, `tool_results_${timestamp}.zip`)
    } catch (err) {
      console.error('[ERROR] Failed to download JSON:', err)
    }
  }

  return (
    <div className="flex h-screen">
      {/* 왼쪽 사이드바 - 세션 목록 */}
      <div className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className={`p-4 border-b border-slate-700 space-y-2 flex flex-col justify-center transition-all ${
          isMultiSelectMode ? 'h-[160px]' : 'h-[100px]'
        }`}>
          <button
            onClick={handleNewChat}
            className="w-full btn btn-primary flex items-center justify-center gap-2"
            disabled={createSessionMutation.isPending}
          >
            <Plus className="w-4 h-4" />
            새 대화
          </button>
          
          {/* 다중 선택 모드 토글 */}
          {sessionsList.length > 0 && (
            <button
              onClick={handleToggleMultiSelect}
              className={`w-full btn flex items-center justify-center gap-2 text-sm ${
                isMultiSelectMode ? 'bg-slate-600 hover:bg-slate-500 text-white' : 'btn-secondary'
              }`}
            >
              {isMultiSelectMode ? (
                <>
                  <X className="w-4 h-4" />
                  취소
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  채팅 내역 선택 삭제
                </>
              )}
            </button>
          )}
          
          {/* 다중 선택 모드일 때 액션 버튼들 */}
          {isMultiSelectMode && (
            <div className="flex gap-2">
              <button
                onClick={handleSelectAll}
                className="flex-1 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-slate-300"
              >
                전체 선택
              </button>
              <button
                onClick={handleDeselectAll}
                className="flex-1 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-slate-300"
              >
                선택 해제
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedSessionIds.size === 0}
                className="flex-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-700 disabled:bg-slate-700 disabled:text-slate-500 rounded text-white"
              >
                삭제 ({selectedSessionIds.size})
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2" ref={sessionsScrollRef} onScroll={handleSessionsScroll}>
          {sessionsLoading && sessionsList.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-4">로딩 중...</div>
          ) : sessionsList.length > 0 ? (
            (() => {
              const rowHeight = 76
              const totalRows = sessionsList.length + 1 // 마지막 행: 로딩/더보기
              const overscan = 12
              const startIndex = Math.max(0, Math.floor(sessionsScrollTop / rowHeight) - overscan)
              const endIndex = Math.min(
                totalRows,
                Math.ceil((sessionsScrollTop + sessionsViewportHeight) / rowHeight) + overscan,
              )

              const rows = []
              for (let index = startIndex; index < endIndex; index += 1) {
                const isLoadMoreRow = index === sessionsList.length

                if (isLoadMoreRow) {
                  rows.push(
                    <div
                      key="__load_more__"
                      style={{ position: 'absolute', top: index * rowHeight, left: 0, right: 0, height: rowHeight }}
                      className="flex items-center justify-center text-slate-400 text-xs"
                      onClick={() => {
                        if (!sessionsFetchingNextPage && sessionsHasNextPage) void fetchNextSessionsPage()
                      }}
                    >
                      {sessionsFetchingNextPage
                        ? '더 불러오는 중...'
                        : sessionsHasNextPage
                          ? '더 불러오기'
                          : '마지막 히스토리입니다.'}
                    </div>,
                  )
                  continue
                }

                const session = sessionsList[index]
                if (!session) continue

                rows.push(
                  <div
                    key={session.id}
                    style={{ position: 'absolute', top: index * rowHeight, left: 0, right: 0, height: rowHeight }}
                    onClick={() => handleSelectSession(session.id)}
                    onContextMenu={(e) => handleContextMenu(session, e)}
                    className={`group relative rounded-lg cursor-pointer transition-colors overflow-hidden ${
                      isMultiSelectMode
                        ? selectedSessionIds.has(session.id)
                          ? 'bg-primary-600 text-white'
                          : 'hover:bg-slate-700/50 text-slate-300'
                        : selectedSessionId === session.id
                          ? 'bg-slate-700 text-white'
                          : 'hover:bg-slate-700/50 text-slate-300'
                    }`}
                  >
                    {/* 다중 선택 모드일 때 체크박스 표시 */}
                    {isMultiSelectMode && (
                      <div
                        className="absolute left-2 top-1/2 -translate-y-1/2"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSelectSession(session.id)
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSessionIds.has(session.id)}
                          onChange={() => {}}
                          className="w-4 h-4 rounded border-slate-500 cursor-pointer"
                        />
                      </div>
                    )}

                    {editingSessionId === session.id ? (
                      <div
                        className="flex items-center gap-2 p-3 h-full"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          className="flex-1 px-2 py-1 text-sm bg-slate-600 border border-slate-500 rounded text-white min-w-0"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit(session.id)
                            if (e.key === 'Escape') handleCancelEdit()
                          }}
                        />
                        <button
                          onClick={() => handleSaveEdit(session.id)}
                          className="flex-shrink-0 p-1 hover:bg-slate-600 rounded"
                        >
                          <Check className="w-4 h-4 text-green-400" />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="flex-shrink-0 p-1 hover:bg-slate-600 rounded"
                        >
                          <X className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    ) : (
                      <div className={`flex items-start gap-2 p-3 h-full ${isMultiSelectMode ? 'ml-6' : ''}`}>
                        <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate" title={session.title}>
                            {session.title}
                          </div>
                          <div className="text-xs text-slate-400 mt-1">{session.message_count}개 메시지</div>
                        </div>
                      </div>
                    )}
                  </div>,
                )
              }

              return (
                <div style={{ position: 'relative', height: totalRows * rowHeight }}>
                  {rows}
                </div>
              )
            })()
          ) : (
            <div className="text-slate-400 text-sm text-center py-4">대화 내역이 없습니다</div>
          )}
        </div>
      </div>

      {/* 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={handleCloseContextMenu}
            onContextMenu={(e) => {
              e.preventDefault()
              handleCloseContextMenu()
            }}
          />
          <div
            className="fixed z-50 bg-slate-700 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[120px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
            }}
          >
            {sessionsList.length > 0 && (() => {
              const session = sessionsList.find(s => s.id === contextMenu.sessionId)
              if (!session) return null
              return (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleEditSession(session, e)
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600 flex items-center gap-2"
                  >
                    <Edit2 className="w-4 h-4" />
                    제목 바꾸기
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(contextMenu.sessionId, e)
                      handleCloseContextMenu()
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    삭제
                  </button>
                </>
              )
            })()}
          </div>
        </>
      )}

      {/* 오른쪽 채팅 영역 */}
      <div className="flex-1 flex flex-col">
        <div className="px-6 border-b border-slate-700 bg-slate-800 h-[100px] flex items-center">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-white flex items-center gap-3">
                <Sparkles className="w-6 h-6 text-yellow-400" />
                AI 어시스턴트
              </h1>
              {aiConfig && (
                <span className="px-2.5 py-1 text-xs font-medium bg-primary-500/20 text-primary-400 rounded-full border border-primary-500/30">
                  {aiConfig.model}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              자연어로 클러스터를 질의하고 문제를 해결하세요
            </p>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-10 sm:px-6 lg:px-10">
            <div className="w-full max-w-4xl flex flex-col items-center">
              <div className="mb-6">
                <ParticleWaveLoader className="w-[clamp(220px,24vh,360px)] h-[clamp(220px,24vh,360px)]" />
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2 text-center">
                새 대화를 시작하세요
              </h2>
              <p className="text-slate-400 mb-8 text-center text-sm sm:text-base">
                아래 질문을 클릭하거나 직접 입력하세요
              </p>

              <div className="grid grid-cols-2 gap-3 w-full px-8">
                {quickQuestions.map((question, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(question)}
                    className="p-4 text-left bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {messages.map((message, idx) => (
              <div
                key={message.id ?? idx}
                className={`flex gap-3 p-6 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div
                  className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                    message.role === 'user'
                      ? 'bg-primary-500'
                      : 'bg-gradient-to-br from-purple-500 to-pink-500'
                  }`}
                >
                  {message.role === 'user' ? (
                    <User className="w-5 h-5 text-white" />
                  ) : (
                    <Bot className="w-5 h-5 text-white" />
                  )}
                </div>
                <div
                  className={`flex-1 p-4 rounded-lg prose prose-invert max-w-3xl overflow-x-auto ${
                    message.role === 'user'
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-700 text-slate-100'
                  }`}
                >
                  {(() => {
                    const hasContent = message.content && message.content.length > 0
                    
                    if (hasContent) {
                      // Tool call이 있고 답변 생성이 아직 시작되지 않았으면 로딩 점 추가
                      const hasToolCalls = message.content.includes('🔧') || message.content.includes('<summary>🔧')
                      const isWaitingForAnswer =
                        message.isTemporary &&
                        message.role === 'assistant' &&
                        (message.streamingPhase === 'waiting' || message.streamingPhase === 'tools')
                      
                      return (
                        <>
                          {message.toolCalls && message.toolCalls.length > 0 && (
                            <div className="flex justify-end mb-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleDownloadJson(message)
                                }}
                                className="px-2.5 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 text-slate-100"
                              >
                                Result ZIP 다운로드 
                              </button>
                            </div>
                          )}
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw]}
                          >
                            {message.role === 'assistant'
                              ? truncateToolResultsInContent(message.content)
                              : message.content}
                          </ReactMarkdown>
                          {hasToolCalls && isWaitingForAnswer && (
                            <div className="flex gap-2 items-center py-3 mt-4">
                              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                              <div
                                className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                                style={{ animationDelay: '0.1s' }}
                              />
                              <div
                                className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                                style={{ animationDelay: '0.2s' }}
                              />
                            </div>
                          )}
                        </>
                      )
                    } else if (message.role === 'assistant') {
                      return (
                        <div className="flex gap-2 items-center py-1">
                          <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                          <div
                            className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                            style={{ animationDelay: '0.1s' }}
                          />
                          <div
                            className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                            style={{ animationDelay: '0.2s' }}
                          />
                        </div>
                      )
                    }
                    return null
                  })()}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* 입력 영역 */}
        <div className="p-4 border-t border-slate-700 bg-slate-800">
          <div className="flex gap-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.isComposing) return
                if (e.key === 'Enter' && e.shiftKey) {
                  e.preventDefault()
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!isStreaming) handleSend()
                }
              }}
              placeholder="메시지를 입력하세요... (Shift+Enter 줄바꿈)"
              disabled={isStreaming}
              rows={1}
              className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-primary-500 disabled:opacity-50 resize-none"
            />
            {isStreaming ? (
              <button
                onClick={handleStop}
                className="btn bg-red-600 hover:bg-red-700 text-white px-6 flex items-center gap-2"
              >
                <StopCircle className="w-4 h-4" />
                중단
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className="btn btn-primary px-6 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
                전송
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
