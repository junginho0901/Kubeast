import { useEffect, useState } from 'react'

import { usePageContext } from '../PageContextProvider'
import { ChatPanel } from './ChatPanel'
import { ToggleButton } from './ToggleButton'

const ANIM_MS = 200

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

  useEffect(() => {
    if (isOpen) {
      // 패널 열기: mount → 다음 tick 에 visible
      setToggleVisible(false)
      setPanelMounted(true)
      const id = window.requestAnimationFrame(() => setPanelVisible(true))
      return () => window.cancelAnimationFrame(id)
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
        />
      )}
    </>
  )
}
