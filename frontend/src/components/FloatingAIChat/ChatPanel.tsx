import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'

import { floatingChatStreamManager } from '@/services/floatingChatStreamManager'
import type {
  ChatStreamState,
} from '@/services/chatStreamManager'
import { api } from '@/services/api'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import type { PageContextSnapshot } from '@/components/PageContext'
import { serializeSnapshotForBackend } from '@/utils/aiContext/serializeSnapshot'
import { chatErrorText } from '@/utils/chatError'
import { failureText, responseFailure } from '@/utils/failureText'
import { ActionFailure } from '@/components/ActionFailure'

import { MessageList, type DisplayMessage } from './MessageList'
import { conversationGone, forgetsConversation, turnsOnScreen } from './turnsOnScreen'
import { modalOpen } from '@/hooks/useModalStack'
import { focusables } from '@/utils/focusables'
import { hiddenEarlier, mergeNewestPage, prependEarlier } from '@/services/sessionMessages'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useEarlierMessages } from '@/hooks/useEarlierMessages'
import EarlierMessages from '@/components/EarlierMessages'
import JumpToLatest from '@/components/JumpToLatest'
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
  /** 상세 드로어가 열려 있으면 드로어 왼쪽 바깥으로 */
  docked: boolean
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
  docked,
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
  const { data: sessionDetail, error: sessionError } = useQuery({
    queryKey: ['floating-session-detail', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
    staleTime: 1000,
  })

  // the tab remembers a conversation this account cannot open (another account's, or deleted): start a new one
  const sessionGone = conversationGone(sessionError, streamState, sessionId)
  const leaveSession = sessionGone && forgetsConversation(streamState, sessionId)
  useEffect(() => {
    if (leaveSession) setSessionId(null)
  }, [leaveSession, setSessionId])

  // 스트리밍 종료 직후 히스토리 리프레시 (a failed turn's question may be saved: the next question's place counts it)
  useEffect(() => {
    if ((streamState.status === 'completed' || streamState.status === 'error') && sessionId) {
      queryClient.invalidateQueries({
        queryKey: ['floating-session-detail', sessionId],
      })
    }
  }, [streamState.status, sessionId, queryClient])

  // why the last stopped answer was not saved; cleared by the next question
  const [stopSaveFailure, setStopSaveFailure] = useState<unknown>(null)

  const handleSubmit = async (message: string) => {
    setStopSaveFailure(null)
    // 세션이 없으면 즉시 생성 (지연 생성 — D22). One the server no longer has is left here, with the turn that found out.
    let activeSessionId = sessionGone ? null : sessionId
    if (!activeSessionId) {
      try {
        const session = await createSessionMutation.mutateAsync()
        activeSessionId = session.id
        setSessionId(activeSessionId)
      } catch {
        // the conversation could not be made: the question goes back in the box, the line above it says why
        return false
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
        activeSessionId === sessionId ? messages.length : 0,
      )
    } catch {
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

    // read after stop, so the letters still queued for the typewriter are saved as shown
    const stopped = floatingChatStreamManager.getState()
    const assistantContent = stopped.content
    if (!assistantContent) {
      // only the question was saved, and the next question's list needs it
      await queryClient.invalidateQueries({
        queryKey: ['floating-session-detail', snapshot.sessionId],
      })
      return
    }

    try {
      const response = await fetch(`/api/v1/sessions/${snapshot.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: assistantContent,
              tool_calls: stopped.toolCalls && stopped.toolCalls.length > 0
                ? stopped.toolCalls
                : undefined,
              stopped: true,
            },
          ],
        }),
      })
      if (response.status === 401) {
        handleUnauthorized()
        return
      }
      if (response.ok) {
        setStopSaveFailure(null)
        await queryClient.invalidateQueries({
          queryKey: ['floating-session-detail', snapshot.sessionId],
        })
      } else {
        setStopSaveFailure(await responseFailure(response))
      }
    } catch (error) {
      // the stopped answer stays on screen but will not be there when the conversation is opened again: say so
      setStopSaveFailure(error)
    }
  }

  // What the panel holds of the conversation: the answer's newest page, under the pages read above it. Adjusted while
  // rendering, so no frame shows the newest page without them.
  const [held, setHeld] = useState({ sessionId, detail: sessionDetail, messages: sessionDetail?.messages ?? [] })
  let heldMessages = held.messages
  if (held.sessionId !== sessionId || held.detail !== sessionDetail) {
    heldMessages = mergeNewestPage(held.sessionId === sessionId ? held.messages : [], sessionDetail?.messages ?? [])
    setHeld({ sessionId, detail: sessionDetail, messages: heldMessages })
  }

  const messages: DisplayMessage[] = useMemo(() => {
    return heldMessages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
      failed: m.usage?.failed === true,
    }))
  }, [heldMessages])

  const ours = streamState.sessionId === sessionId
  const isStreaming = streamState.isStreaming && ours

  // A call that failed (the model refused, the budget, a cut stream) keeps the question and the letters that came on screen, with the error under them.
  const visibleMessages: DisplayMessage[] = useMemo(
    () => (ours
      ? turnsOnScreen(messages, streamState, ({ error, errorKey, errorArgs }) => chatErrorText(t, error ?? '', errorKey, errorArgs))
      : messages),
    [messages, ours, streamState, t],
  )

  // follows new text only while the reader is at the bottom; a new question scrolls back smoothly
  const { ref: listRef, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([visibleMessages])
  const earlier = useEarlierMessages({
    sessionId,
    oldestId: heldMessages[0]?.id,
    listRef,
    content: [visibleMessages],
    onPage: (page) => setHeld((h) => ({ ...h, messages: prependEarlier(h.messages, page) })),
  })
  const questions = visibleMessages.filter((m) => m.role === 'user').length
  const lastQuestions = useRef(questions)
  useEffect(() => {
    // a question just sent scrolls smoothly; a history that loads jumps at once
    if (questions > lastQuestions.current) scrollToBottom(isStreaming ? undefined : { instant: true })
    lastQuestions.current = questions
  }, [questions, isStreaming, scrollToBottom])
  // 세션은 첫 질문 시점에 생성하므로 평소엔 활성. 세션 생성 중이거나 스트리밍 중일 때 입력 비활성.
  const disabled = createSessionMutation.isPending

  // Keys pressed in the panel stay here, so a modal or drawer under it does not close on Escape or take the focus on Tab.
  // Once Escape has closed it they pass on, also before the fade starts: a second Escape closes the window under it.
  const closing = useRef(false)
  useEffect(() => {
    if (visible) closing.current = false
  }, [visible])
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!visible || closing.current) return
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.stopPropagation()
      closing.current = true
      onClose()
    } else if (e.key === 'Tab' && modalOpen()) {
      e.stopPropagation()
      const list = focusables(e.currentTarget)
      if (list.length === 0) return
      const first = list[0], last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  return (
    <div
      data-testid="floating-chat-panel"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={`fixed bottom-6 right-6 z-1300 flex h-[min(70vh,640px)] w-[min(92vw,440px)] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-black/40 backdrop-blur-sm transition-all duration-200 ease-out motion-reduce:transition-none origin-bottom-right focus:outline-hidden ${
        docked ? 'min-[1348px]:right-[756px] min-[1348px]:w-[min(440px,calc(100vw-1028px))]' : ''
      } ${
        visible
          ? 'opacity-100 scale-100 translate-y-0'
          : 'opacity-0 scale-95 translate-y-2 pointer-events-none'
      }`}
    >
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <img src="/icon.svg" alt="" className="h-4 w-4 shrink-0" data-testid="floating-title-icon" />
            {t('floatingChat.title', { defaultValue: 'AI Chat' })}
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

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="flex-1 overflow-y-auto" data-testid="floating-messages">
        {disabled ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('floatingChat.sessionLoading', { defaultValue: 'Preparing session...' })}
          </div>
        ) : (
          <>
          <EarlierMessages hidden={hiddenEarlier(sessionDetail, heldMessages)} loading={earlier.loading} error={earlier.error} onLoad={earlier.load} />
          <MessageList
            messages={visibleMessages}
            emptyExtras={
              <SuggestedQuestions
                pageType={currentPageType ?? 'default'}
                onPick={(q) => void handleSubmit(q)}
              />
            }
          />
          </>
        )}
      </div>
      {!atBottom && <JumpToLatest onClick={() => scrollToBottom()} />}
      </div>

      <ActionFailure error={stopSaveFailure} action="save" testId="floating-stop-save-error" className="shrink-0 px-3 pt-2 text-xs" />
      {createSessionMutation.error && (
        <p role="alert" data-testid="floating-start-error" className="shrink-0 px-3 pt-2 text-xs text-red-400 break-words">
          {t('aiChat.errorSessionCreate', { error: failureText(createSessionMutation.error) })}
        </p>
      )}
      <InputArea
        onSubmit={handleSubmit}
        onStop={handleStop}
        isStreaming={isStreaming}
        disabled={disabled}
        onNewChat={sessionId ? () => { setStopSaveFailure(null); setSessionId(null) } : undefined}
      />
    </div>
  )
}
