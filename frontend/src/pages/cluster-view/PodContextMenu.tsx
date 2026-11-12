// Pod 우클릭 컨텍스트 메뉴. ClusterView.tsx 에서 추출 (Phase 3.1.a).
//
// 부모는 좌표 + 대상 pod + admin 여부만 넘기고, Exec / Delete 액션은 콜백으로
// 받는다. 상세 데이터 (PodDetail) 변환과 모달 state 토글은 부모 책임 — 이
// 컴포넌트는 메뉴 UI 와 클릭 라우팅만 담당.

import { Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PodInfo } from '@/services/api'

export interface PodContextMenuState {
  x: number
  y: number
  pod: PodInfo
}

interface Props {
  menu: PodContextMenuState | null
  isAdmin: boolean
  onClose: () => void
  onExec: (pod: PodInfo) => void
  onDelete: (pod: PodInfo) => void
}

export function PodContextMenu({ menu, isAdmin, onClose, onExec, onDelete }: Props) {
  const { t } = useTranslation()
  if (!menu) return null
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-50 bg-slate-700 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[140px]"
        style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        role="menu"
      >
        {isAdmin && (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onExec(menu.pod)
              onClose()
            }}
            className="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600 flex items-center gap-2"
            role="menuitem"
          >
            <Terminal className="w-4 h-4" />
            Exec
          </button>
        )}
        <button
          onClick={(event) => {
            event.stopPropagation()
            onDelete(menu.pod)
            onClose()
          }}
          className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600 flex items-center gap-2"
          role="menuitem"
        >
          <Trash2 className="w-4 h-4" />
          {t('common.delete', { defaultValue: 'Delete' })}
        </button>
      </div>
    </>
  )
}
