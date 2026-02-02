import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, Session } from '@/services/api'
import ParticleWaveLoader from '@/components/ParticleWaveLoader'
import { Send, Bot, User, Sparkles, Plus, MessageSquare, Trash2, Edit2, Check, X, StopCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
  isTemporary?: boolean  // 스트리밍 중 임시 메시지 표시
  // Tool 호출 결과 (DB의 tool_calls 컬럼 그대로)
  toolCalls?: any[] 
}

export default function AIChat() {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [hasStoppedMessage, setHasStoppedMessage] = useState(false)  // 중단된 메시지 플래그
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false)  // 다중 선택 모드
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())  // 선택된 세션들
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)  // 우클릭 컨텍스트 메뉴
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const streamToolCallsRef = useRef<any[]>([])  // 현재 스트리밍 중인 tool 호출 정보

  // 세션 목록 조회
  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.getSessions,
  })

  // 세션 상세 조회 (스트리밍 중이 아닐 때만)
  const { data: sessionDetail } = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => api.getSession(selectedSessionId!),
    enabled: !!selectedSessionId && !isStreaming,
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

  // 세션 상세가 로드되면 메시지 설정 (스트리밍 중이 아닐 때만)
  useEffect(() => {
    if (sessionDetail && !isStreaming && !hasStoppedMessage) {
      console.log('[DEBUG] Loading messages from DB:', sessionDetail.messages.length, 'messages')
      console.log('[DEBUG] Current messages count:', messages.length)
      
      const dbMessages = sessionDetail.messages.map((msg) => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        toolCalls: msg.tool_calls || undefined,
      }))
      
      // 임시 메시지가 있으면 제거하고 DB 데이터로 교체
      setMessages((prev) => {
        const hasTemporary = prev.some(msg => msg.isTemporary)
        if (hasTemporary) {
          console.log('[DEBUG] Replacing temporary messages with DB data')
          return dbMessages
        }
        // 임시 메시지가 없으면 그냥 DB 데이터로 설정
        return dbMessages
      })
    }
  }, [sessionDetail, isStreaming, hasStoppedMessage])

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
    console.log('[DEBUG] Stop button clicked')
    // 중단된 메시지가 있으므로, 일단 DB에서 세션 메시지를 다시 덮어쓰지 않도록 플래그 설정
    setHasStoppedMessage(true)

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsStreaming(false)
    
    // 현재 메시지 상태에서 assistant 메시지 찾기
    const assistantMsg = messages.find(msg => msg.isTemporary && msg.role === 'assistant')
    
    if (selectedSessionId && assistantMsg && assistantMsg.content) {
      try {
        // DB에 중단된 assistant 메시지만 저장 (user 메시지는 이미 백엔드에서 저장됨)
        console.log('[DEBUG] Saving stopped assistant message to DB')
        const response = await fetch(`/api/v1/sessions/${selectedSessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { 
                role: 'assistant', 
                content: assistantMsg.content,
                tool_calls: streamToolCallsRef.current.length > 0 ? streamToolCallsRef.current : undefined,
              }
            ]
          })
        })
        
        if (response.ok) {
          console.log('[DEBUG] Messages saved successfully')
          // DB에 저장했으므로 다시 불러오기
          await queryClient.refetchQueries({ queryKey: ['session', selectedSessionId] })
          await queryClient.invalidateQueries({ queryKey: ['sessions'] })
          // 이 시점 이후에는 hasStoppedMessage는 다음 사용자 액션(새 질문/세션 전환)까지 유지
          // -> UI에서는 현재까지 생성된 답변을 그대로 보여주고,
          //    이후 세션 전환 또는 새 질문 시에만 DB 데이터로 동기화
        }
      } catch (error) {
        console.error('[ERROR] Failed to save stopped messages:', error)
        // 이미 hasStoppedMessage를 true로 설정했으므로, 저장 실패 시에도
        // DB에서 덮어쓰지 않고 화면에만 유지
      }
    }
    
    // 임시 플래그 제거하여 메시지를 화면에 유지
    setMessages((prev) => {
      console.log('[DEBUG] Keeping messages on stop:', prev.length)
      return prev.map((msg) => ({
        ...msg,
        isTemporary: false,
      }))
    })
  }

  const handleSend = async (messageToSend?: string) => {
    const message = messageToSend || input.trim()
    if (!message || isStreaming) return

    const userMessage = message

    // 중단된 메시지 플래그 리셋
    setHasStoppedMessage(false)

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
      { role: 'assistant', content: '', isTemporary: true }  // 로딩용 빈 메시지
    ])
    setInput('')
    setIsStreaming(true)

    // 렌더링 시간 확보 (로딩 표시가 보이도록)
    await new Promise(resolve => setTimeout(resolve, 100))

    // AbortController 생성
    abortControllerRef.current = new AbortController()
    // 스트리밍용 tool 호출 정보 초기화
    streamToolCallsRef.current = []

    try {
      const response = await fetch(`/api/v1/ai/sessions/${sessionId}/chat?message=${encodeURIComponent(userMessage)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: abortControllerRef.current.signal,
      })

      if (!response.body) throw new Error('No response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let assistantMessageContent = ''
      let functionCallsContent = ''  // Tool call 정보를 별도로 저장

      console.log('[DEBUG] Starting streaming')

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter((line) => line.trim() !== '')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            if (dataStr === '[DONE]') break

            try {
              const data = JSON.parse(dataStr)

              if (data.content) {
                assistantMessageContent += data.content
                setMessages((prev) => {
                  console.log('[DEBUG] Updating message. Current messages:', prev.length, 'Temporary messages:', prev.filter(m => m.isTemporary).length)
                  
                  // 임시 assistant 메시지 찾기 (마지막이 아닐 수도 있음)
                  const tempAssistantIndex = prev.findIndex(
                    (msg) => msg.role === 'assistant' && msg.isTemporary
                  )
                  
                  console.log('[DEBUG] Temp assistant index:', tempAssistantIndex, 'Content length:', assistantMessageContent.length)
                  
                  if (tempAssistantIndex !== -1) {
                    const updated = [...prev]
                    // Tool call 정보 + 실제 답변 내용을 합침 (로딩 텍스트는 자동으로 사라짐)
                    updated[tempAssistantIndex] = {
                      ...updated[tempAssistantIndex],
                      content: functionCallsContent + assistantMessageContent,
                    }
                    return updated
                  }
                  console.warn('[WARN] No temporary assistant message found!')
                  return prev
                })
              } else if (data.function) {
                // Function call 시작 - KAgent 스타일
                console.log('Function call:', data.function, data.args)
                
                // 스트리밍 중 tool 호출 정보 갱신
                streamToolCallsRef.current = [
                  ...streamToolCallsRef.current,
                  {
                    function: data.function,
                    args: data.args || {},
                    result: '',
                    is_json: false,
                  },
                ]
                // 현재 임시 assistant 메시지에 toolCalls 반영 (스트리밍 중에도 JSON 버튼 표시)
                setMessages((prev) => {
                  const tempAssistantIndex = prev.findIndex(
                    (msg) => msg.role === 'assistant' && msg.isTemporary
                  )
                  if (tempAssistantIndex !== -1) {
                    const updated = [...prev]
                    updated[tempAssistantIndex] = {
                      ...updated[tempAssistantIndex],
                      toolCalls: [...streamToolCallsRef.current],
                    }
                    return updated
                  }
                  return prev
                })
                
                const args_json = JSON.stringify(data.args, null, 2)
                const args_section = Object.keys(data.args).length > 0 
                  ? `<details>
<summary><strong>📋 Arguments</strong></summary>

\`\`\`json
${args_json}
\`\`\`

</details>`
                  : '<p><strong>📋 Arguments:</strong> No arguments</p>'
                
                const functionCallText = `<details>
<summary>🔧 <strong>${data.function}</strong></summary>

${args_section}

<details>
<summary><strong>📊 Results</strong></summary>

Executing...

</details>

</details>

`
                
                functionCallsContent += functionCallText
                
                // 임시 assistant 메시지에 function call 정보 즉시 추가
                setMessages((prev) => {
                  const tempAssistantIndex = prev.findIndex(
                    (msg) => msg.role === 'assistant' && msg.isTemporary
                  )
                  
                  if (tempAssistantIndex !== -1) {
                    const updated = [...prev]
                    updated[tempAssistantIndex] = {
                      ...updated[tempAssistantIndex],
                      content: functionCallsContent + assistantMessageContent,
                    }
                    return updated
                  }
                  return prev
                })
              } else if (data.function_result) {
                // Function 실행 결과 - 기존 "Executing..." 을 실제 결과로 교체
                console.log('Function result:', data.function_result, data.result)
                
                // 스트리밍 중 tool 호출 정보에 결과 반영
                streamToolCallsRef.current = streamToolCallsRef.current.map((tc) =>
                  tc.function === data.function_result
                    ? {
                        ...tc,
                        result: data.result,
                        is_json: !!data.is_json,
                      }
                    : tc
                )
                
                // 마지막 function call의 "Executing..."을 실제 결과로 교체
                const lastFunctionIndex = functionCallsContent.lastIndexOf(`<summary>🔧 <strong>${data.function_result}</strong></summary>`)
                if (lastFunctionIndex !== -1) {
                  const beforeFunction = functionCallsContent.substring(0, lastFunctionIndex)
                  const afterFunction = functionCallsContent.substring(lastFunctionIndex)
                  
                  const codeBlock = data.is_json
                    ? `\`\`\`json\n${data.result}\n\`\`\``
                    : `\`\`\`\n${data.result}\n\`\`\``
                  
                  // "Executing..."을 실제 결과로 교체
                  const updatedAfterFunction = afterFunction.replace(
                    'Executing...',
                    codeBlock
                  )
                  
                  functionCallsContent = beforeFunction + updatedAfterFunction
                  
                  // 화면 업데이트
                  setMessages((prev) => {
                    const tempAssistantIndex = prev.findIndex(
                      (msg) => msg.role === 'assistant' && msg.isTemporary
                    )
                    
                    if (tempAssistantIndex !== -1) {
                      const updated = [...prev]
                      updated[tempAssistantIndex] = {
                        ...updated[tempAssistantIndex],
                        content: functionCallsContent + assistantMessageContent,
                        toolCalls: [...streamToolCallsRef.current],
                      }
                      return updated
                    }
                    return prev
                  })
                }
              } else if (data.error) {
                console.error('Error:', data.error)
              }
            } catch (e) {
              // JSON 파싱 실패 무시
            }
          }
        }
      }

      // 스트리밍 완료 후 DB에서 최신 메시지 불러오기
      console.log('[DEBUG] Streaming complete, refetching from DB')
      abortControllerRef.current = null
      console.log('[DEBUG] Refetching session data')
      
      // DB에서 최신 데이터 불러오기
      await queryClient.invalidateQueries({ queryKey: ['sessions'] })
      await queryClient.refetchQueries({ queryKey: ['session', sessionId] })
      
      // 스트리밍 종료 (useEffect가 작동하여 DB 데이터로 교체)
      setIsStreaming(false)
    } catch (error: any) {
      // Abort 에러는 무시 (사용자가 의도적으로 중단)
      if (error.name === 'AbortError') {
        console.log('[DEBUG] Streaming aborted by user - keeping current messages')
        // 중단 시: isStreaming은 이미 handleStop에서 false로 설정됨
        // 임시 플래그만 제거하여 메시지는 화면에 유지 (DB에는 저장 안 함)
        return
      }
      
      console.error('Streaming error:', error)
      setIsStreaming(false)  // 에러 시에도 스트리밍 종료
      abortControllerRef.current = null
      // 에러 시 임시 메시지 제거
      setMessages((prev) => prev.filter((msg) => !msg.isTemporary))
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `죄송합니다. 답변을 생성하는 중 오류가 발생했습니다: ${error}` },
      ])
    }
  }

  const handleNewChat = () => {
    // 세션을 미리 생성하지 않고, 선택만 해제 (첫 질문 시 자동 생성)
    setSelectedSessionId(null)
    setHasStoppedMessage(false)
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
      setHasStoppedMessage(false)
    }
  }

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('이 대화를 삭제하시겠습니까?')) {
      deleteSessionMutation.mutate(sessionId)
    }
  }

  const handleToggleMultiSelect = () => {
    setIsMultiSelectMode(!isMultiSelectMode)
    setSelectedSessionIds(new Set())
  }

  const handleDeleteSelected = async () => {
    if (selectedSessionIds.size === 0) return
    
    if (confirm(`선택한 ${selectedSessionIds.size}개의 대화를 삭제하시겠습니까?`)) {
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
                  className={`flex-1 p-4 rounded-lg prose prose-invert max-w-none ${
                    message.role === 'user'
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-700 text-slate-100'
                  }`}
                >
                  {(() => {
                    const hasContent = message.content && message.content.length > 0
                    
                    if (hasContent) {
                      // Tool call이 있고 실제 답변이 없으면 로딩 점 추가
                      const hasToolCalls = message.content.includes('🔧') || message.content.includes('<summary>🔧')
                      // 실제 답변이 있는지 확인 - ## 제목이나 한글 문장이 충분히 있으면
                      const hasMarkdownHeading = message.content.includes('##')
                      const koreanTextLength = (message.content.match(/[가-힣]/g) || []).length
                      const hasActualResponse = hasMarkdownHeading || koreanTextLength > 20
                      
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
                            {message.content}
                          </ReactMarkdown>
                          {hasToolCalls && !hasActualResponse && message.isTemporary && (
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
