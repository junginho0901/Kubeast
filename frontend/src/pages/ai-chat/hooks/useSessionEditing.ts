import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Session } from '@/services/api'
import { useContextMenuDismiss } from './useContextMenuDismiss'

// 세션 제목 인라인 편집 + 우클릭 컨텍스트 메뉴 + update mutation.
// 셋이 강하게 결합되어 한 hook 으로 묶음 (handleSaveEdit 이 update mutation 을
// 직접 호출, mutation onSuccess 가 editingSessionId 를 reset). context-menu
// dismiss (외부 클릭/ESC) 도 내부 호출.

interface ContextMenuPosition {
  x: number
  y: number
  sessionId: string
}

interface Params {
  isMultiSelectMode: boolean
}

interface Result {
  editingSessionId: string | null
  setEditingSessionId: (id: string | null) => void
  editingTitle: string
  setEditingTitle: (s: string) => void
  contextMenu: ContextMenuPosition | null
  handleEditSession: (session: Session, e?: React.MouseEvent) => void
  handleContextMenu: (session: Session, e: React.MouseEvent) => void
  handleCloseContextMenu: () => void
  handleSaveEdit: (sessionId: string) => void
  handleCancelEdit: () => void
}

export function useSessionEditing({ isMultiSelectMode }: Params): Result {
  const queryClient = useQueryClient()
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null)

  useContextMenuDismiss({ contextMenu, setContextMenu })

  const updateSessionMutation = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.updateSession(sessionId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setEditingSessionId(null)
    },
  })

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

  return {
    editingSessionId,
    setEditingSessionId,
    editingTitle,
    setEditingTitle,
    contextMenu,
    handleEditSession,
    handleContextMenu,
    handleCloseContextMenu,
    handleSaveEdit,
    handleCancelEdit,
  }
}
