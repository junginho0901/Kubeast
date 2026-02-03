import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, Session } from '@/services/api'
import { chatStreamManager, ChatStreamState } from '@/services/chatStreamManager'
import ParticleWaveLoader from '@/components/ParticleWaveLoader'
import { Send, Bot, User, Sparkles, Plus, MessageSquare, Trash2, Edit2, Check, X, StopCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

const TOOL_RESULT_DISPLAY_MAX_CHARS = 2000
const TRUNCATED_MARKER = '... (truncated) ...'

function truncateToolResultsInContent(content: string, maxChars = TOOL_RESULT_DISPLAY_MAX_CHARS) {
  if (!content) return content

  // Only truncate tool "📊 Results" blocks. Keep other code blocks intact.
  const resultsBlockRegex =
    /(<summary><strong>📊 Results<\/strong><\/summary>[\s\S]*?```(?:json)?\r?\n)([\s\S]*?)(\r?\n```)/g

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

export default function AIChat() {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
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
  const [forceDbSyncSessionId, setForceDbSyncSessionId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamStateRef = useRef<ChatStreamState>(streamState)

  const isStreaming = streamState.isStreaming

  // 세션 목록 조회
  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.getSessions,
  })

  // 세션 상세 조회 (스트리밍 중이 아닐 때만)
  const { data: sessionDetail } = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => api.getSession(selectedSessionId!),
    enabled: !!selectedSessionId,
  })

  // AI 설정 정보 조회 (모델명)
  const { data: aiConfig } = useQuery({
    queryKey: ['ai-config'],
    queryFn: api.getAIConfig,
    staleTime: Infinity, // 설정은 변경되지 않으므로 캐시 무한정 유지
  })

  // 세션 생성
  const createSessionMutation = useMutation({
    // 첫 질문 내용을 기반으로 초기 제목 설정 (없으면 New Chat)
    mutationFn: (title?: string) => api.createSession(title || 'New Chat'),
    onSuccess: (newSession) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setSelectedSessionId(newSession.id)
      setMessages([])
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

      // 스트리밍이 끝나고(완료) DB에 저장된 최종 메시지/툴 결과로 강제 동기화
      if (forceDbSyncSessionId && sessionDetail.id === forceDbSyncSessionId) {
        setMessages(dbMessages)
        setLastLoadedSessionId(sessionDetail.id)
        setForceDbSyncSessionId(null)
        return
      }

      // 1) 세션이 바뀐 경우: DB 데이터로 완전히 교체
      if (sessionDetail.id !== lastLoadedSessionId) {
        console.log('[DEBUG] Session changed, replacing messages from DB')
        setMessages(dbMessages)
        setLastLoadedSessionId(sessionDetail.id)
        return
      }

      // 2) 같은 세션인 경우:
      //    - 아직 화면에 영구 메시지가 없으면(DB 초기 로드 등) DB로 교체
      //    - 이미 user/assistant 메시지가 있으면 그대로 유지 (스트리밍 완료 후 덮어쓰지 않음)
      setMessages((prev) => {
        const hasNonTemporary = prev.some(msg => !msg.isTemporary)
        if (!hasNonTemporary) {
          console.log('[DEBUG] No non-temporary messages yet, syncing from DB')
          return dbMessages
        }
        console.log('[DEBUG] Keeping existing messages (same session, non-temporary present)')
        return prev
      })
    }
  }, [forceDbSyncSessionId, sessionDetail, stoppedSessionId, lastLoadedSessionId])

  // 스트리밍 상태는 라우트 이동(언마운트) 이후에도 유지될 수 있으므로,
  // 전역 스트림 매니저에서 상태를 구독한다.
  useEffect(() => {
    const unsubscribe = chatStreamManager.subscribe((s) => {
      streamStateRef.current = s
      setStreamState(s)
    })
    return unsubscribe
  }, [])

  // 현재 선택된 세션이 스트리밍 중인 세션이라면, 스트리밍 내용을 UI에 반영
  useEffect(() => {
    if (streamState.status !== 'streaming') return
    if (!streamState.sessionId) return
    if (selectedSessionId !== streamState.sessionId) return

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
  }, [selectedSessionId, streamState])

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
      setForceDbSyncSessionId(streamState.sessionId)
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
          headers: { 'Content-Type': 'application/json' },
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

    // 중단 플래그 리셋
    setStoppedSessionId(null)

    // 세션이 없으면 생성
    let sessionId = selectedSessionId
    if (!sessionId) {
      // 첫 질문 내용으로 세션 제목 설정 (최대 50자)
      const initialTitle =
        userMessage.length > 50 ? `${userMessage.slice(0, 50)}...` : userMessage
      const newSession = await createSessionMutation.mutateAsync(initialTitle)
      sessionId = newSession.id
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

    // 스트리밍 시작 (라우트 이동 후에도 유지)
    void chatStreamManager.startSessionChat(sessionId, userMessage).catch((error) => {
      console.error('[ERROR] Failed to start streaming:', error)
      setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `죄송합니다. 답변을 생성하는 중 오류가 발생했습니다: ${String(error)}` },
      ])
    })
  }

  const handleNewChat = () => {
    // 세션을 미리 생성하지 않고, 선택만 해제 (첫 질문 시 자동 생성)
    setSelectedSessionId(null)
    setStoppedSessionId(null)
    setMessages([])
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
      setStoppedSessionId(null)
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
        await deleteSessionMutation.mutateAsync(sessionId)
      }
      
      // 삭제 후 상태 초기화
      setSelectedSessionIds(new Set())
      setIsMultiSelectMode(false)
      
      // 현재 선택된 세션이 삭제되었으면 초기화
      if (selectedSessionId && selectedSessionIds.has(selectedSessionId)) {
        setSelectedSessionId(null)
        setStoppedSessionId(null)
        setMessages([])
      }
    }
  }

  const handleSelectAll = () => {
    if (sessions) {
      setSelectedSessionIds(new Set(sessions.map(s => s.id)))
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
      const toolCalls = message.toolCalls as any[]

      // === Special case: get_pod_logs →
      // 기본은 AI가 분석했던 시점의 스냅샷(tc.result)을 그대로 사용하되,
      // 예전 세션처럼 tc.result 안에 '... (truncated) ...'가 포함된 경우에만
      // 가능하면 K8s API를 다시 호출해서 전체 로그를 받아온다.
      if (
        toolCalls.length === 1 &&
        toolCalls[0] &&
        toolCalls[0].function === 'get_pod_logs' &&
        typeof toolCalls[0].result === 'string'
      ) {
        const tc = toolCalls[0]
        const args = (tc.args || {}) as any

        let rawLogs = String(tc.result)

        // 예전 버전에서 저장된 truncated 결과라면, 한 번만 전체 로그 재조회 시도
        if (rawLogs.includes('... (truncated) ...')) {
          try {
            const ns = typeof args.namespace === 'string' ? args.namespace : 'default'
            const podName =
              (args.pod_name as string) ||
              (args.podName as string) ||
              ''
            const tailLines =
              (args.tail_lines as number) ||
              (args.tailLines as number) ||
              100

            if (podName) {
              // 컨테이너 자동 선택을 위해 먼저 Pod 목록에서 대상 파드를 찾는다
              const podsInNs = await api.getPods(ns)
              const targetPod = podsInNs.find((p) => p.name === podName)

              if (targetPod && Array.isArray(targetPod.containers)) {
                const containerNames = targetPod.containers
                  .map((c: any) => c?.name)
                  .filter((n: any) => typeof n === 'string' && n.length > 0)

                let containerName: string | undefined

                if (containerNames.length === 1) {
                  containerName = containerNames[0]
                } else if (containerNames.length > 1) {
                  const sidecarExact = new Set(['istio-proxy', 'istio-init', 'linkerd-proxy'])
                  const sidecarPrefixes = ['istio-', 'linkerd-', 'vault-', 'kube-rbac-proxy']

                  const candidates = containerNames.filter(
                    (n) =>
                      !sidecarExact.has(n) &&
                      !sidecarPrefixes.some((prefix) => n.startsWith(prefix)),
                  )

                  if (candidates.length === 1) {
                    containerName = candidates[0]
                  } else {
                    // 여러 개면 첫 번째 컨테이너를 기본값으로 사용
                    containerName = containerNames[0]
                  }
                }

                rawLogs = await api.getPodLogs(ns, podName, containerName, tailLines)
              } else {
                // Pod 정보를 못 찾으면 container 없이 시도 (단일 컨테이너일 수도 있으므로)
                rawLogs = await api.getPodLogs(ns, podName, undefined, tailLines)
              }
            }
          } catch (e) {
            console.error(
              '[ERROR] Failed to refetch full logs for truncated result, keep stored snapshot:',
              e,
            )
          }
        }

        const blob = new Blob([rawLogs], {
          type: 'text/plain;charset=utf-8',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url

        const now = new Date()
        const pad = (n: number) => n.toString().padStart(2, '0')
        const timestamp = `${now.getFullYear()}${pad(
          now.getMonth() + 1,
        )}${pad(now.getDate())}-${pad(now.getHours())}${pad(
          now.getMinutes(),
        )}${pad(now.getSeconds())}`

        a.download = `get_pod_logs_${timestamp}.log`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return
      }

      // 1) JSON 결과(is_json === true)가 하나뿐인 경우:
      //    -> 기본적으로 그 tool의 result 문자열만 그대로 파일로 저장
      //    -> 단, result 안에 '... (truncated) ...' 가 포함되어 있으면
      //       가능한 경우 직접 API를 다시 호출해서 전체 JSON을 가져온다
      const jsonToolCalls = toolCalls.filter(
        (tc) => tc && tc.is_json && typeof tc.result === 'string',
      )

      let blobContent: string

      if (jsonToolCalls.length === 1) {
        const tc = jsonToolCalls[0]
        const raw = String(tc.result)

        const isTruncated = raw.includes('... (truncated) ...')
        const fnName = tc.function as string | undefined
        const args = (tc.args || {}) as any

        // get_pods 처럼 다시 조회가 가능한 툴이고, 결과가 잘린 경우에는
        // 직접 클러스터 API를 호출해서 전체 데이터를 가져와 JSON으로 저장
        if (isTruncated && fnName) {
          try {
            if (fnName === 'get_pods' && typeof args.namespace === 'string') {
              const pods = await api.getPods(args.namespace)
              blobContent = JSON.stringify(pods, null, 2)
            } else if (fnName === 'get_node_list') {
              const nodes = await api.getNodes()
              blobContent = JSON.stringify(nodes, null, 2)
            } else if (fnName === 'get_cluster_overview') {
              const overview = await api.getClusterOverview()
              blobContent = JSON.stringify(overview, null, 2)
            } else if (fnName === 'get_deployments' && typeof args.namespace === 'string') {
              const deployments = await api.getDeployments(args.namespace)
              blobContent = JSON.stringify(deployments, null, 2)
            } else if (fnName === 'get_services' && typeof args.namespace === 'string') {
              const services = await api.getServices(args.namespace)
              blobContent = JSON.stringify(services, null, 2)
            } else {
              // 지원하지 않는 툴이거나 args 부족하면 원본 문자열 그대로 사용
              blobContent = raw
            }
          } catch (e) {
            console.error('[ERROR] Failed to refetch full JSON for download:', e)
            blobContent = raw
          }
        } else {
          // 잘리지 않았거나, 재조회 대상이 아니면 원본 result 그대로 사용
          blobContent = raw
        }
      } else if (jsonToolCalls.length > 1) {
        // 2) JSON 결과가 여러 개면:
        //    가능한 것은 실제 JSON으로 파싱해서 배열로 저장,
        //    파싱 실패하면 해당 항목은 문자열 그대로 배열에 포함
        const items: any[] = []
        for (const tc of jsonToolCalls) {
          const raw = String(tc.result)
          const trimmed = raw.trim()
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              items.push(JSON.parse(trimmed))
            } catch {
              items.push(raw)
            }
          } else {
            items.push(raw)
          }
        }
        blobContent = JSON.stringify(items, null, 2)
      } else {
        // 3) is_json 표시가 없는 경우(로그 등)에는 기존처럼 전체 toolCalls 구조를 JSON으로 저장
        blobContent = JSON.stringify(toolCalls, null, 2)
      }

      const blob = new Blob([blobContent], {
        type: 'application/json;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // 파일 이름: 호출된 tool 이름들 + 타임스탬프
      const toolNames = (message.toolCalls || [])
        .map((tc: any) => tc?.function)
        .filter((name: any) => typeof name === 'string' && name.length > 0)
      const uniqueToolNames = Array.from(new Set(toolNames))
      const toolPart =
        uniqueToolNames.length > 0
          ? uniqueToolNames.join('+').slice(0, 40)
          : 'tool'

      const now = new Date()
      const pad = (n: number) => n.toString().padStart(2, '0')
      const timestamp = `${now.getFullYear()}${pad(
        now.getMonth() + 1
      )}${pad(now.getDate())}-${pad(now.getHours())}${pad(
        now.getMinutes()
      )}${pad(now.getSeconds())}`

      a.download = `${toolPart}_${timestamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
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
          {sessions && sessions.length > 0 && (
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

        <div className="flex-1 overflow-y-auto p-2">
          {sessionsLoading ? (
            <div className="text-slate-400 text-sm text-center py-4">로딩 중...</div>
          ) : sessions && Array.isArray(sessions) && sessions.length > 0 ? (
            <div className="space-y-1">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  onContextMenu={(e) => {
                    const sessionData = sessions.find(s => s.id === session.id)
                    if (sessionData) handleContextMenu(sessionData, e)
                  }}
                  className={`group relative p-3 rounded-lg cursor-pointer transition-colors ${
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
                    <div className="flex items-center gap-2 -mx-3 -my-3 p-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        className="flex-1 px-2 py-1 text-sm bg-slate-600 border border-slate-500 rounded text-white min-w-0"
                        autoFocus
                        onKeyPress={(e) => {
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
                    <div className={`flex items-start gap-2 ${isMultiSelectMode ? 'ml-6' : ''}`}>
                      <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium break-words">{session.title}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {session.message_count}개 메시지
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
            {sessions && (() => {
              const session = sessions.find(s => s.id === contextMenu.sessionId)
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
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="mb-4">
              <ParticleWaveLoader />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">새 대화를 시작하세요</h2>
            <p className="text-slate-400 mb-6">아래 질문을 클릭하거나 직접 입력하세요</p>
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
                                Result JSON 다운로드 
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
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !isStreaming && handleSend()}
              placeholder="메시지를 입력하세요..."
              disabled={isStreaming}
              className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-primary-500 disabled:opacity-50"
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
