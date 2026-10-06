// AI Chat 좌측 세션 사이드바 + 우클릭 컨텍스트 메뉴. AIChat.tsx 에서 추출
// (Phase 3.2.b).
//
// 세션 목록 (가상 스크롤) / 새 채팅 버튼 / 다중 선택 모드 / 편집·삭제 메뉴 /
// 우클릭 컨텍스트 메뉴 까지 포함. props 가 많은 이유는 메시지/스트리밍 state
// 가 부모에 있어 콜백 위임이 필요하기 때문 — 다음 PR (3.2.c) 의
// useChatSessions hook 추출로 sessions 관련 props 는 sidebar 자체 hook 호출로
// 흡수 예정.

import type { Session } from '@/services/api'
import { Plus, MessageSquare, Trash2, Edit2, Check, X } from 'lucide-react'

interface ContextMenuState {
  x: number
  y: number
  sessionId: string
}

interface Props {
  // session list
  sessionsList: Session[]
  sessionsLoading: boolean
  sessionsHasNextPage: boolean
  sessionsFetchingNextPage: boolean
  fetchNextSessions: () => void
  sessionsScrollRef: React.RefObject<HTMLDivElement>
  sessionsScrollTop: number
  sessionsViewportHeight: number
  handleSessionsScroll: (e: React.UIEvent<HTMLDivElement>) => void

  // selection state
  selectedSessionId: string | null

  // mutations
  createSessionMutation: { isPending: boolean }

  // multi-select
  isMultiSelectMode: boolean
  selectedSessionIds: Set<string>
  handleToggleMultiSelect: () => void
  handleSelectAll: () => void
  handleDeselectAll: () => void
  handleDeleteSelected: () => void

  // edit
  editingSessionId: string | null
  editingTitle: string
  setEditingTitle: (v: string) => void
  handleEditSession: (s: Session, e?: React.MouseEvent) => void
  handleSaveEdit: (sessionId: string) => void
  handleCancelEdit: () => void

  // selection / delete
  handleSelectSession: (id: string) => void
  handleNewChat: () => void
  handleDeleteSession: (id: string, e: React.MouseEvent) => Promise<void> | void

  // context menu
  contextMenu: ContextMenuState | null
  handleContextMenu: (s: Session, e: React.MouseEvent) => void
  handleCloseContextMenu: () => void

  t: (key: string, options?: any) => string
}

export function SessionSidebar({
  sessionsList,
  sessionsLoading,
  sessionsHasNextPage,
  sessionsFetchingNextPage,
  fetchNextSessions,
  sessionsScrollRef,
  sessionsScrollTop,
  sessionsViewportHeight,
  handleSessionsScroll,
  selectedSessionId,
  createSessionMutation,
  isMultiSelectMode,
  selectedSessionIds,
  handleToggleMultiSelect,
  handleSelectAll,
  handleDeselectAll,
  handleDeleteSelected,
  editingSessionId,
  editingTitle,
  setEditingTitle,
  handleEditSession,
  handleSaveEdit,
  handleCancelEdit,
  handleSelectSession,
  handleNewChat,
  handleDeleteSession,
  contextMenu,
  handleContextMenu,
  handleCloseContextMenu,
  t,
}: Props) {
  return (
    <>
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
            {t('aiChat.newChat')}
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
                  {t('aiChat.multiSelectCancel')}
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  {t('aiChat.multiSelectDelete')}
                </>
              )}
            </button>
          )}
          
          {/* 다중 선택 모드일 때 액션 버튼들 */}
          {isMultiSelectMode && (
            <div className="flex gap-2">
              <button
                onClick={handleSelectAll}
                className="flex-1 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded-sm text-slate-300"
              >
                {t('aiChat.selectAll')}
              </button>
              <button
                onClick={handleDeselectAll}
                className="flex-1 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded-sm text-slate-300"
              >
                {t('aiChat.deselectAll')}
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedSessionIds.size === 0}
                className="flex-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-700 disabled:bg-slate-700 disabled:text-slate-500 rounded-sm text-white"
              >
                {t('aiChat.deleteWithCount', { count: selectedSessionIds.size })}
              </button>
            </div>
          )}
        </div>
      
        <div className="flex-1 overflow-y-auto p-2" ref={sessionsScrollRef} onScroll={handleSessionsScroll}>
          {sessionsLoading && sessionsList.length === 0 ? (
            <div className="text-slate-400 text-sm text-center py-4">{t('aiChat.loading')}</div>
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
                        if (!sessionsFetchingNextPage && sessionsHasNextPage) void fetchNextSessions()
                      }}
                    >
                      {sessionsFetchingNextPage
                        ? t('aiChat.loadMoreLoading')
                        : sessionsHasNextPage
                          ? t('aiChat.loadMore')
                          : t('aiChat.endOfHistory')}
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
                          className="w-4 h-4 rounded-sm border-slate-500 cursor-pointer"
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
                          className="flex-1 px-2 py-1 text-sm bg-slate-600 border border-slate-500 rounded-sm text-white min-w-0"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit(session.id)
                            if (e.key === 'Escape') handleCancelEdit()
                          }}
                        />
                        <button
                          onClick={() => handleSaveEdit(session.id)}
                          className="shrink-0 p-1 hover:bg-slate-600 rounded-sm"
                        >
                          <Check className="w-4 h-4 text-green-400" />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="shrink-0 p-1 hover:bg-slate-600 rounded-sm"
                        >
                          <X className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    ) : (
                      <div className={`flex items-start gap-2 p-3 h-full ${isMultiSelectMode ? 'ml-6' : ''}`}>
                        <MessageSquare className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate" title={session.title}>
                            {session.title}
                          </div>
                          <div className="text-xs text-slate-400 mt-1">
                            {t('aiChat.messageCount', { count: session.message_count })}
                          </div>
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
            <div className="text-slate-400 text-sm text-center py-4">{t('aiChat.noSessions')}</div>
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
                    {t('aiChat.rename')}
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
                    {t('aiChat.delete')}
                  </button>
                </>
              )
            })()}
          </div>
        </>
      )}
    </>
  )
}
