import { ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalStackEntry } from '@/hooks/useModalStack'

interface ModalOverlayProps {
  children: ReactNode
  onClose?: () => void
  closeOnOverlayClick?: boolean
}

export function ModalOverlay({ children, onClose, closeOnOverlayClick = true }: ModalOverlayProps) {
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const isTop = useModalStackEntry(true)

  useEffect(() => {
    if (!onClose) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isTop])

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
      onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
      onClick={(e) => {
        if (!closeOnOverlayClick || !onClose) return
        if (!isTop()) return
        // mousedown과 click 모두 overlay 자체에서 발생했을 때만 닫기
        // (드래그가 모달 안에서 시작돼서 밖으로 빠진 경우 방지)
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onClose()
        }
      }}
    >
      {children}
    </div>,
    document.body
  )
}
