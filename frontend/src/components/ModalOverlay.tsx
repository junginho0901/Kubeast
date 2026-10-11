import { ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalStackEntry } from '@/hooks/useModalStack'

interface ModalOverlayProps {
  children: ReactNode
  onClose?: () => void
  closeOnOverlayClick?: boolean
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

export function ModalOverlay({ children, onClose, closeOnOverlayClick = true }: ModalOverlayProps) {
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const { isTop, zIndex } = useModalStackEntry(true)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape' && onClose) onClose()
      // Tab cycles inside the top-most modal (an editor that took the key, e.g. Monaco indenting, is left alone)
      if (e.key === 'Tab' && !e.defaultPrevented && overlayRef.current) {
        const list = focusables(overlayRef.current)
        if (list.length === 0) { e.preventDefault(); return }
        const first = list[0], last = list[list.length - 1]
        const active = document.activeElement
        const inside = overlayRef.current.contains(active)
        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isTop])

  // Focus moves into the modal when it opens (unless a control inside already
  // took it, e.g. autoFocus) and back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const el = overlayRef.current
    if (el && !el.contains(document.activeElement)) focusables(el)[0]?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
      style={{ zIndex }}
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
