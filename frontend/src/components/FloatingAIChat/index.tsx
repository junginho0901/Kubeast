import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { usePageContext } from '../PageContext'
import { useResourceDetail } from '../ResourceDetailContext'
// The panel carries the markdown renderer; fetch it when first opened.
const ChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })))
import { ToggleButton } from './ToggleButton'
import { focusOrigin, returnFocus } from './focusReturn'
import { FLOATING_SESSION_KEY } from '@/services/floatingChatSession'
import { useChatShortcut } from '@/hooks/useChatShortcut'
import { useChatScrollVisibility } from '@/hooks/useChatScrollVisibility'

const ANIM_MS = 200

function readPersistedSessionId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage.getItem(FLOATING_SESSION_KEY)
  } catch {
    return null
  }
}

/**
 * 플로팅 AI 위젯 루트.
 *
 * - `/ai-chat` 페이지에서는 숨김 (전체 AI 채팅 페이지와 중복 방지)
 * - 토글 버튼 ↔ 패널 전환 시 200ms fade + scale 애니메이션
 *   - mount/unmount 와 visible 상태를 분리하여 exit 애니메이션 후 DOM 제거
 * - 모달 위(z 1300)에 뜨고, 상세 드로어(폭 740px)가 열려 있으면 드로어 왼쪽 바깥으로 옮김 — 1348px 미만 화면은 그대로
 * - ⌘/ (Mac) · Ctrl+/ 로 열고 닫음 (`useChatShortcut`): 이 컴포넌트가 있는 동안만 — AI 가 꺼져 있으면 Layout 이 그리지 않음
 * - 열면 입력칸에 포커스, 닫으면 열 때 포커스가 있던 곳(없으면 토글 버튼)으로 돌려줌
 */
export default function FloatingAIChat() {
  const { pageType, pageTitle, getSnapshot, consumeContextChanged } = usePageContext()
  const docked = !!useResourceDetail().target
  const [isOpen, setIsOpen] = useState(false)
  // 패널: isOpen=true 시 즉시 mount → 다음 frame 에 visible=true (enter 트랜지션)
  //       isOpen=false 시 visible=false → ANIM_MS 후 mount=false (exit 트랜지션)
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelVisible, setPanelVisible] = useState(false)
  // 토글 버튼은 패널의 반대 — 패널이 사라지는 동안 함께 페이드인
  const [toggleVisible, setToggleVisible] = useState(true)
  // 세션 id 는 부모에서 소유 → 패널 unmount/remount 에도 살아남음.
  // sessionStorage 에 미러링하여 F5 새로고침에도 유지, 탭 닫으면 자동 정리, 로그아웃 때 지움.
  const [sessionId, setSessionId] = useState<string | null>(() => readPersistedSessionId())

  const handleSessionIdChange = useCallback((id: string | null) => {
    setSessionId(id)
    try {
      if (id) window.sessionStorage.setItem(FLOATING_SESSION_KEY, id)
      else window.sessionStorage.removeItem(FLOATING_SESSION_KEY)
    } catch {
      // sessionStorage 사용 불가 (private 모드 등) — in-memory 만 유지
    }
  }, [])

  const toggleRef = useRef<HTMLButtonElement>(null)
  const scrollHidden = useChatScrollVisibility(toggleRef, isOpen || !toggleVisible || pageType === 'ai-chat')
  const panelRef = useRef<HTMLDivElement>(null)
  const openedFrom = useRef<HTMLElement | null>(null)
  const focusToggle = useRef(false)
  const open = useCallback(() => {
    openedFrom.current = focusOrigin(document)
    focusToggle.current = false
    setIsOpen(true)
  }, [])
  const close = useCallback(() => {
    setIsOpen(false)
    focusToggle.current = returnFocus(document, panelRef.current, openedFrom.current, toggleRef.current) === 'toggle'
    openedFrom.current = null
  }, [])
  // the button takes the focus once it is shown again, not while it is aria-hidden, and only if nothing took it meanwhile
  useEffect(() => {
    if (!toggleVisible || !focusToggle.current) return
    focusToggle.current = false
    if (!focusOrigin(document)) toggleRef.current?.focus()
  }, [toggleVisible])
  useChatShortcut(pageType !== 'ai-chat', () => (isOpen ? close() : open()))

  useEffect(() => {
    if (isOpen) {
      // 패널 열기: mount → 두 번의 RAF 후 visible (React 18 batching 회피).
      // 단일 RAF 만 쓰면 같은 microtask 에 setState 가 flushed 되어
      // visible=false 첫 렌더가 paint 되지 않고 곧장 visible=true 로 그려져 transition 발생 안 함.
      setToggleVisible(false)
      setPanelMounted(true)
      let raf2 = 0
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => setPanelVisible(true))
      })
      return () => {
        window.cancelAnimationFrame(raf1)
        if (raf2) window.cancelAnimationFrame(raf2)
      }
    }
    // 패널 닫기: visible=false → ANIM_MS 후 unmount + 토글 visible
    setPanelVisible(false)
    const t = window.setTimeout(() => {
      setPanelMounted(false)
      setToggleVisible(true)
    }, ANIM_MS)
    return () => window.clearTimeout(t)
  }, [isOpen])

  if (pageType === 'ai-chat') return null

  return (
    <>
      <ToggleButton onClick={open} visible={toggleVisible} docked={docked} buttonRef={toggleRef} scrollHidden={scrollHidden} />
      {panelMounted && (
        <Suspense fallback={null}>
          <ChatPanel
            onClose={close}
            panelRef={panelRef}
            getSnapshot={getSnapshot}
            consumeContextChanged={consumeContextChanged}
            currentPageTitle={pageTitle}
            currentPageType={pageType}
            visible={panelVisible}
            docked={docked}
            sessionId={sessionId}
            onSessionIdChange={handleSessionIdChange}
          />
        </Suspense>
      )}
    </>
  )
}
