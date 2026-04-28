import { useCallback, useEffect, useState } from 'react'

import { usePageContext } from '../PageContextProvider'
import { ChatPanel } from './ChatPanel'
import { ToggleButton } from './ToggleButton'

const ANIM_MS = 200
const SESSION_STORAGE_KEY = 'kubest.floatingChat.sessionId'

function readPersistedSessionId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY)
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
 */
export default function FloatingAIChat() {
  const { pageType, pageTitle, getSnapshot, consumeContextChanged } = usePageContext()
  const [isOpen, setIsOpen] = useState(false)
  // 패널: isOpen=true 시 즉시 mount → 다음 frame 에 visible=true (enter 트랜지션)
  //       isOpen=false 시 visible=false → ANIM_MS 후 mount=false (exit 트랜지션)
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelVisible, setPanelVisible] = useState(false)
  // 토글 버튼은 패널의 반대 — 패널이 사라지는 동안 함께 페이드인
  const [toggleVisible, setToggleVisible] = useState(true)
  // 세션 id 는 부모에서 소유 → 패널 unmount/remount 에도 살아남음.
  // sessionStorage 에 미러링하여 F5 새로고침에도 유지, 탭 닫으면 자동 정리.
  const [sessionId, setSessionId] = useState<string | null>(() => readPersistedSessionId())

  const handleSessionIdChange = useCallback((id: string | null) => {
    setSessionId(id)
    try {
      if (id) window.sessionStorage.setItem(SESSION_STORAGE_KEY, id)
      else window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // sessionStorage 사용 불가 (private 모드 등) — in-memory 만 유지
    }
  }, [])

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
      <ToggleButton onClick={() => setIsOpen(true)} visible={toggleVisible} />
      {panelMounted && (
        <ChatPanel
          onClose={() => setIsOpen(false)}
          getSnapshot={getSnapshot}
          consumeContextChanged={consumeContextChanged}
          currentPageTitle={pageTitle}
          currentPageType={pageType}
          visible={panelVisible}
          sessionId={sessionId}
          onSessionIdChange={handleSessionIdChange}
        />
      )}
    </>
  )
}
