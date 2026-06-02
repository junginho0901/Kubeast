import { useEffect } from 'react'

// 우클릭 컨텍스트 메뉴를 외부 클릭 / ESC 로 닫는다.
// AIChat 의 session sidebar 에서만 사용 (다른 곳에서 contextMenu 같은 패턴이
// 생기면 그땐 분리).

interface Params<T> {
  contextMenu: T | null
  setContextMenu: (m: T | null) => void
}

export function useContextMenuDismiss<T>({ contextMenu, setContextMenu }: Params<T>) {
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) setContextMenu(null)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [contextMenu, setContextMenu])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && contextMenu) setContextMenu(null)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [contextMenu, setContextMenu])
}
