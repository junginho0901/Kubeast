import { useTranslation } from 'react-i18next'
import { SessionSidebar } from './SessionSidebar'
import { ChatMain } from './ChatMain'
import { useChatSessions } from './useChatSessions'
import { useChatStreamSync } from './useChatStreamSync'
import { useSessionsScrollViewport } from './hooks/useSessionsScrollViewport'
import { useChatStreamState } from './hooks/useChatStreamState'
import { useSessionDetailSync } from './hooks/useSessionDetailSync'
import { useStreamEndSync } from './hooks/useStreamEndSync'
import { useSessionMutations } from './hooks/useSessionMutations'
import { useMessageActions } from './hooks/useMessageActions'
import { useSessionEditing } from './hooks/useSessionEditing'
import { useChatHandlers } from './hooks/useChatHandlers'
import { useAIChat } from './AIChatContext'

// AIChat 의 본체 — AIChatProvider 안에서만 mount. 모든 hook 을 호출하고
// 결과를 SessionSidebar / ChatMain 에 props 로 전달. modal/filter state 는
// useAIChat() 으로 child 가 직접 가져감.
//
// hook 호출 순서가 중요: useChatStreamState 가 messagesRef 를 만들고,
// useSessionDetailSync 가 그걸 받아 동기 시점에 읽는다. messagesRef 의
// "현재 messages" 반영은 useChatStreamState 의 useEffect 가 담당하므로
// useChatStreamState → useSessionDetailSync 순서 필수.

export function AIChatBody() {
  const { t } = useTranslation()

  const {
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
  } = useAIChat()

  // 전역 stream manager 구독 + messagesRef/streamStateRef
  const { streamState, streamStateRef, messagesRef } = useChatStreamState({ messages })
  const isStreaming = streamState.isStreaming

  // 세션 목록 무한스크롤
  const {
    sessionsList,
    sessionsLoading,
    sessionsFetchingNextPage,
    fetchNextSessionsPage,
    sessionsHasNextPage,
    upsertSessionAtFront,
  } = useChatSessions({ pinnedSessions })

  // 좌측 사이드바 viewport
  const {
    sessionsScrollRef,
    sessionsScrollTop,
    sessionsViewportHeight,
    handleSessionsScroll,
  } = useSessionsScrollViewport({
    sessionsHasNextPage,
    sessionsFetchingNextPage,
    fetchNextSessionsPage,
  })

  // 세션 제목 인라인 편집 + 우클릭 컨텍스트 메뉴 + update mutation
  const {
    editingSessionId,
    editingTitle,
    setEditingTitle,
    contextMenu,
    handleEditSession,
    handleContextMenu,
    handleCloseContextMenu,
    handleSaveEdit,
    handleCancelEdit,
  } = useSessionEditing({ isMultiSelectMode })

  // 세션 상세 조회 + DB↔UI 동기화 100줄 분기
  useSessionDetailSync({
    selectedSessionId,
    stoppedSessionId,
    pendingFinalSyncSessionId,
    lastLoadedSessionId,
    setLastLoadedSessionId,
    setPendingFinalSyncSessionId,
    setViewSessionId,
    setMessages,
    streamStateRef,
    messagesRef,
  })

  // 세션 create / delete mutation
  const {
    createSessionMutation,
    deleteSessionMutation,
  } = useSessionMutations({
    upsertSessionAtFront,
    setPinnedSessions,
    setViewSessionId,
    setSelectedSessionId,
    setMessages,
    selectedSessionId,
  })

  useChatStreamSync({ streamState, selectedSessionId, viewSessionId, setMessages })

  // 스트리밍 종료(완료/오류/중단) 처리
  useStreamEndSync({
    streamState,
    selectedSessionId,
    setPendingFinalSyncSessionId,
    setMessages,
    t,
  })

  // 메시지 단위 액션 (복사 / zip)
  const { copiedMessageKey, handleCopyMessage, handleDownloadJson } = useMessageActions({
    viewSessionId,
    selectedSessionId,
    messagesRef,
    t,
  })

  // 메인 핸들러 swarm
  const {
    handleStop,
    handleSend,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    handleToggleMultiSelect,
    handleDeleteSelected,
    handleSelectAll,
    handleDeselectAll,
  } = useChatHandlers({
    input,
    setInput,
    selectedSessionId,
    setSelectedSessionId,
    setViewSessionId,
    setStoppedSessionId,
    setPendingFinalSyncSessionId,
    pinnedSessions,
    setPinnedSessions,
    setMessages,
    isMultiSelectMode,
    setIsMultiSelectMode,
    selectedSessionIds,
    setSelectedSessionIds,
    sessionsList,
    streamState,
    isStreaming,
    upsertSessionAtFront,
    createSessionMutation,
    deleteSessionMutation,
    t,
  })

  return (
    <div className="flex h-screen">
      <SessionSidebar
        sessionsList={sessionsList}
        sessionsLoading={sessionsLoading}
        sessionsHasNextPage={sessionsHasNextPage}
        sessionsFetchingNextPage={sessionsFetchingNextPage}
        fetchNextSessions={fetchNextSessionsPage}
        sessionsScrollRef={sessionsScrollRef}
        sessionsScrollTop={sessionsScrollTop}
        sessionsViewportHeight={sessionsViewportHeight}
        handleSessionsScroll={handleSessionsScroll}
        selectedSessionId={selectedSessionId}
        createSessionMutation={createSessionMutation}
        isMultiSelectMode={isMultiSelectMode}
        selectedSessionIds={selectedSessionIds}
        handleToggleMultiSelect={handleToggleMultiSelect}
        handleSelectAll={handleSelectAll}
        handleDeselectAll={handleDeselectAll}
        handleDeleteSelected={handleDeleteSelected}
        editingSessionId={editingSessionId}
        editingTitle={editingTitle}
        setEditingTitle={setEditingTitle}
        handleEditSession={handleEditSession}
        handleSaveEdit={handleSaveEdit}
        handleCancelEdit={handleCancelEdit}
        handleSelectSession={handleSelectSession}
        handleNewChat={handleNewChat}
        handleDeleteSession={handleDeleteSession}
        contextMenu={contextMenu}
        handleContextMenu={handleContextMenu}
        handleCloseContextMenu={handleCloseContextMenu}
        t={t}
      />

      <ChatMain
        isStreaming={isStreaming}
        copiedMessageKey={copiedMessageKey}
        onCopy={handleCopyMessage}
        onDownloadJson={handleDownloadJson}
        onSend={handleSend}
        onStop={handleStop}
        t={t}
      />
    </div>
  )
}
