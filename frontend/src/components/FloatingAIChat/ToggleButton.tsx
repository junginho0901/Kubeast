import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'

interface ToggleButtonProps {
  onClick: () => void
  /** 페이드/스케일 인-아웃 애니메이션 제어 (FloatingAIChat 에서 관리) */
  visible: boolean
}

/**
 * 우하단 플로팅 토글 버튼. 클릭 시 ChatPanel 오픈.
 *
 * `visible=false` 시 페이드아웃 + 살짝 축소 → 부모가 unmount 처리.
 * 클릭 가능 영역도 같이 비활성화하여 hidden 중 클릭 사고를 방지.
 */
export function ToggleButton({ onClick, visible }: ToggleButtonProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      className={`fixed bottom-6 right-6 z-[1200] flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-white shadow-lg shadow-primary-900/40 transition-all duration-200 ease-out hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
        visible
          ? 'opacity-100 scale-100 hover:scale-105 pointer-events-auto'
          : 'opacity-0 scale-90 pointer-events-none'
      }`}
      aria-label={t('floatingChat.openAriaLabel', { defaultValue: 'Open AI Assistant' })}
    >
      <MessageSquare className="h-5 w-5" />
    </button>
  )
}
