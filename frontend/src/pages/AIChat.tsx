import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, Session } from '@/services/api'
import { Send, Bot, User, Sparkles, Plus, MessageSquare, Trash2, Edit2, Check, X, StopCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

interface Message {
  role: 'user' | 'assistant'
  content: string
  isTemporary?: boolean  // 스트리밍 중 임시 메시지 표시
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

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

  // 세션 생성
  const createSessionMutation = useMutation({
    mutationFn: () => api.createSession('New Chat'),
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
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
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

  const handleStop = async () => {
    console.log('[DEBUG] Stop button clicked')
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
              { role: 'assistant', content: assistantMsg.content }
            ]
          })
        })
        
        if (response.ok) {
          console.log('[DEBUG] Messages saved successfully')
          // DB에 저장했으므로 다시 불러오기
          await queryClient.refetchQueries({ queryKey: ['session', selectedSessionId] })
          await queryClient.invalidateQueries({ queryKey: ['sessions'] })
          setHasStoppedMessage(false)  // 플래그 리셋
        }
      } catch (error) {
        console.error('[ERROR] Failed to save stopped messages:', error)
        // 저장 실패 시 화면에만 유지
        setHasStoppedMessage(true)
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

    // 중단된 메시지 플래그 리셋
    setHasStoppedMessage(false)

    // 세션이 없으면 생성
    let sessionId = selectedSessionId
    if (!sessionId) {
      const newSession = await createSessionMutation.mutateAsync()
      sessionId = newSession.id
    }

    const userMessage = message
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
                
                // 마지막 function call의 "Executing..."을 실제 결과로 교체
                const lastFunctionIndex = functionCallsContent.lastIndexOf(`<summary>🔧 <strong>${data.function_result}</strong></summary>`)
                if (lastFunctionIndex !== -1) {
                  const beforeFunction = functionCallsContent.substring(0, lastFunctionIndex)
                  const afterFunction = functionCallsContent.substring(lastFunctionIndex)
                  
                  // "Executing..."을 실제 결과로 교체
                  const updatedAfterFunction = afterFunction.replace(
                    'Executing...',
                    `\`\`\`\n${data.result}\n\`\`\``
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
      // 일반 모드에서는 세션 선택
      setSelectedSessionId(sessionId)
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

  const handleEditSession = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
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
    '클러스터에 문제가 있는 Pod를 찾아줘',
    'CPU 사용률이 높은 리소스는?',
    'PVC가 Pending 상태인 이유는?',
    '리소스 최적화 방법을 알려줘',
  ]

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
          ) : sessions && sessions.length > 0 ? (
            <div className="space-y-1">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
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
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        className="flex-1 px-2 py-1 text-sm bg-slate-600 border border-slate-500 rounded text-white"
                        autoFocus
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(session.id)
                          if (e.key === 'Escape') handleCancelEdit()
                        }}
                      />
                      <button
                        onClick={() => handleSaveEdit(session.id)}
                        className="p-1 hover:bg-slate-600 rounded"
                      >
                        <Check className="w-4 h-4 text-green-400" />
                      </button>
                      <button onClick={handleCancelEdit} className="p-1 hover:bg-slate-600 rounded">
                        <X className="w-4 h-4 text-red-400" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={`flex items-start gap-2 ${isMultiSelectMode ? 'ml-6' : ''}`}>
                        <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{session.title}</div>
                          <div className="text-xs text-slate-400 mt-1">
                            {session.message_count}개 메시지
                          </div>
                        </div>
                      </div>
                      {/* 다중 선택 모드가 아닐 때만 편집/삭제 버튼 표시 */}
                      {!isMultiSelectMode && (
                        <div className="absolute right-2 top-2 hidden group-hover:flex gap-1">
                          <button
                            onClick={(e) => handleEditSession(session, e)}
                            className="p-1 hover:bg-slate-600 rounded"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => handleDeleteSession(session.id, e)}
                            className="p-1 hover:bg-slate-600 rounded"
                          >
                            <Trash2 className="w-3 h-3 text-red-400" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-slate-400 text-sm text-center py-4">대화 내역이 없습니다</div>
          )}
        </div>
      </div>

      {/* 오른쪽 채팅 영역 */}
      <div className="flex-1 flex flex-col">
        <div className="px-6 border-b border-slate-700 bg-slate-800 h-[100px] flex items-center">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-white flex items-center gap-3">
              <Sparkles className="w-6 h-6 text-yellow-400" />
              AI 어시스턴트
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              자연어로 클러스터를 질의하고 문제를 해결하세요
            </p>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <Sparkles className="w-16 h-16 text-yellow-400 mb-4" />
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
                key={idx}
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
                    console.log(`[DEBUG] Message ${idx}: role=${message.role}, hasContent=${hasContent}, content="${message.content}"`)
                    
                    if (hasContent) {
                      // Tool call이 있고 실제 답변이 없으면 로딩 점 추가
                      const hasToolCalls = message.content.includes('🔧') || message.content.includes('<summary>🔧')
                      // 실제 답변이 있는지 확인 - ## 제목이나 한글 문장이 충분히 있으면
                      const hasMarkdownHeading = message.content.includes('##')
                      const koreanTextLength = (message.content.match(/[가-힣]/g) || []).length
                      const hasActualResponse = hasMarkdownHeading || koreanTextLength > 20
                      
                      console.log('[DEBUG LOADING]', {
                        hasToolCalls,
                        hasActualResponse,
                        isTemporary: message.isTemporary,
                        hasMarkdownHeading,
                        koreanTextLength,
                        shouldShowLoading: hasToolCalls && !hasActualResponse && message.isTemporary
                      })
                      
                      return (
                        <>
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{message.content}</ReactMarkdown>
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
                      console.log('[DEBUG] Showing loading dots for empty assistant message')
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
