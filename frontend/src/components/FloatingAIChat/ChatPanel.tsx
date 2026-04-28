import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'

import { floatingChatStreamManager } from '@/services/floatingChatStreamManager'
import type {
  ChatStreamState,
} from '@/services/chatStreamManager'
import { api } from '@/services/api'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import type { PageContextSnapshot } from '@/components/PageContextProvider'
import { serializeSnapshotForBackend } from '@/utils/aiContext/serializeSnapshot'

import { MessageList, type DisplayMessage } from './MessageList'
import { InputArea } from './InputArea'
import { SuggestedQuestions } from './SuggestedQuestions'

interface ChatPanelProps {
  onClose: () => void
  getSnapshot: () => PageContextSnapshot
  consumeContextChanged: () => boolean
  currentPageTitle?: string
  currentPageType?: string
  /** 페이드/스케일 인-아웃 애니메이션 제어 (FloatingAIChat 에서 관리) */
  visible: boolean
  /** 패널 닫고 다시 열어도 유지되도록 부모가 세션 id 를 소유 */
  sessionId: string | null
  onSessionIdChange: (id: string | null) => void
}

/**
 * 플로팅 AI 채팅 패널.
 *
 * - 첫 마운트 시 세션 자동 생성 (title="New Chat", 첫 질문 전송 후 AIService 가 제목 자동 갱신 + [플로팅] prefix)
 * - 질문 전송: `getSnapshot()` 으로 현재 화면 스냅샷 수집 후 JSON body 로 ai-service 에 전달
 * - 응답 스트리밍: `floatingChatStreamManager` 구독, 실시간 타자기 효과
 * - 스트리밍 완료 시 세션 상세(메시지 히스토리) 리프레시
 */
export function ChatPanel({
  onClose,
  getSnapshot,
  consumeContextChanged,
  currentPageTitle,
  currentPageType,
  visible,
  sessionId,
  onSessionIdChange,
}: ChatPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const setSessionId = onSessionIdChange
  const [streamState, setStreamState] = useState<ChatStreamState>(
    floatingChatStreamManager.getState(),
  )

  useEffect(() => {
    return floatingChatStreamManager.subscribe(setStreamState)
  }, [])

  // 세션은 첫 질문 전송 시점에 생성 (D22 — AIChat 과 같은 세션 DB 공유).
  // mount 시점에 자동 생성하면 패널 열고 닫을 때마다 빈 세션이 누적된다.
  const createSessionMutation = useMutation({
    mutationFn: () => api.createSession('New Chat'),
  })

  // 메시지 히스토리
  const { data: sessionDetail } = useQuery({
    queryKey: ['floating-session-detail', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
    staleTime: 1000,
  })

  // 스트리밍 종료 직후 히스토리 리프레시
  useEffect(() => {
    if (streamState.status === 'completed' && sessionId) {
      queryClient.invalidateQueries({
        queryKey: ['floating-session-detail', sessionId],
      })
    }
  }, [streamState.status, sessionId, queryClient])

  const handleSubmit = async (message: string) => {
    // 세션이 없으면 즉시 생성 (지연 생성 — D22)
    let activeSessionId = sessionId
    if (!activeSessionId) {
      try {
        const session = await createSessionMutation.mutateAsync()
        activeSessionId = session.id
        setSessionId(activeSessionId)
      } catch {
        return
      }
    }

    const snapshot = getSnapshot()
    // consume 하면 contextChanged 플래그가 false 로 리셋되어 다음 질문에 전달 안 됨.
    // 스냅샷은 이미 현재 값을 참조하고 있으므로 consume 은 여기서 실행.
    consumeContextChanged()

    // 백엔드 Pydantic 스키마는 snake_case 라 직렬화 변환 필수
    const extraBody = {
      page_context: serializeSnapshotForBackend(snapshot),
    } satisfies Record<string, unknown>

    try {
      await floatingChatStreamManager.startSessionChat(
        activeSessionId,
        message,
        extraBody,
      )
    } catch (e) {
      // ChatStreamManager 가 내부 상태에 error 를 기록하므로 별도 처리 불필요
    }
  }

  const handleStop = async () => {
    // AIChat 페이지와 같은 partial-save 패턴 — abort 후 그때까지 받은
    // assistant content + tool calls 를 별도 API 로 저장한다.
    // (백엔드 session_chat_stream 은 stream 끝까지 도달해야 add_message 하므로
    //  중단 시점에서는 user 메시지만 DB 에 있고 assistant 는 사라진다.)
    const snapshot = floatingChatStreamManager.getState()
    if (!snapshot.sessionId || !snapshot.isStreaming) {
      void floatingChatStreamManager.stop()
      return
    }

    await floatingChatStreamManager.stop()

    const assistantContent = snapshot.functionCallsContent + snapshot.assistantContent
    if (!assistantContent) return

    try {
      const response = await fetch(`/api/v1/sessions/${snapshot.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: assistantContent,
              tool_calls: snapshot.toolCalls && snapshot.toolCalls.length > 0
                ? snapshot.toolCalls
                : undefined,
            },
          ],
        }),
      })
      if (response.status === 401) {
        handleUnauthorized()
        return
      }
      if (response.ok) {
        await queryClient.invalidateQueries({
          queryKey: ['floating-session-detail', snapshot.sessionId],
        })
      }
    } catch {
      // 저장 실패 시 사용자 화면에는 stream 멈춘 그대로 표시되므로 무해
    }
  }

  const messages: DisplayMessage[] = useMemo(() => {
    const history = sessionDetail?.messages ?? []
    return history.map((m) => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }))
  }, [sessionDetail])

  const isStreaming = streamState.isStreaming && streamState.sessionId === sessionId

  // 스트리밍 중이면 히스토리 + 현재 진행중 user 메시지 + 진행중 assistant content
  const visibleMessages: DisplayMessage[] = useMemo(() => {
    if (!isStreaming) return messages
    const pendingUser: DisplayMessage[] = streamState.userMessage
      ? [
          {
            id: `pending-user-${streamState.updatedAt}`,
            role: 'user',
            content: streamState.userMessage,
            pending: true,
          },
        ]
      : []
    return [...messages, ...pendingUser]
  }, [messages, isStreaming, streamState.userMessage, streamState.updatedAt])

  const streamingContent = isStreaming ? streamState.assistantContent : undefined
  const error = streamState.status === 'error' ? streamState.error : null
  // 세션은 첫 질문 시점에 생성하므로 평소엔 활성. 세션 생성 중이거나 스트리밍 중일 때 입력 비활성.
  const disabled = createSessionMutation.isPending

  return (
    <div
      className={`fixed bottom-6 right-6 z-[1200] flex h-[min(70vh,640px)] w-[min(92vw,440px)] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-black/40 backdrop-blur transition-all duration-200 ease-out origin-bottom-right ${
        visible
          ? 'opacity-100 scale-100 translate-y-0'
          : 'opacity-0 scale-95 translate-y-2 pointer-events-none'
      }`}
    >
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">
            {t('floatingChat.title', { defaultValue: 'AI Assistant' })}
          </div>
          <div className="truncate text-xs text-slate-400">
            {currentPageTitle
              ? t('floatingChat.currentPage', { title: currentPageTitle, defaultValue: `Current page: ${currentPageTitle}` })
              : t('floatingChat.contextIncluded', { defaultValue: 'Current page context included' })}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          aria-label={t('floatingChat.closeAriaLabel', { defaultValue: 'Close' })}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {disabled ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('floatingChat.sessionLoading', { defaultValue: 'Preparing session...' })}
          </div>
        ) : (
          <MessageList
            messages={visibleMessages}
            streamingContent={streamingContent}
            error={error}
            emptyExtras={
              <SuggestedQuestions
                pageType={currentPageType ?? 'default'}
                onPick={(q) => void handleSubmit(q)}
              />
            }
          />
        )}
      </div>

      <InputArea
        onSubmit={handleSubmit}
        onStop={handleStop}
        isStreaming={isStreaming}
        disabled={disabled}
      />
    </div>
  )
}
