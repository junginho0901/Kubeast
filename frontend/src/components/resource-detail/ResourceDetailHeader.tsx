// ResourceDetailDrawer 의 Header (제목 / 닫기 / 뒤로가기 / Helm 배지) +
// Tabs (Info/YAML + Delete 버튼). ResourceDetailDrawer.tsx 에서 추출
// (Phase 3.3.d).
//
// props 가 많은 이유: tab 상태 / 삭제 버튼 콜백 / 닫기·뒤로가기 lifecycle
// 이 모두 부모 (drawer) 가 관리하기 때문. 구조만 분리하는 thin presentational.

import { ArrowLeft, X, Info, FileCode, Trash2 } from 'lucide-react'
import { TabId, kindIcon } from './utils'
import { HelmReleaseBadge } from './HelmReleaseBadge'

interface Props {
  kind: string
  ns: string | null | undefined
  name: string
  effectiveRawJson: any
  canGoBack: boolean
  canDelete: boolean
  tab: TabId
  onClose: () => void
  onGoBack: () => void
  onTabChange: (tab: TabId) => void
  onDeleteClick: () => void
  t: (key: string, opts?: any) => string
}

export function ResourceDetailHeader({
  kind,
  ns,
  name,
  effectiveRawJson,
  canGoBack,
  canDelete,
  tab,
  onClose,
  onGoBack,
  onTabChange,
  onDeleteClick,
  t,
}: Props) {
  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-slate-700 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm">{kindIcon(kind)}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-medium">{kind}</span>
            {ns && <span className="text-xs text-slate-500">{ns}</span>}
          </div>
          <h2 className="text-lg font-semibold text-white truncate">{name}</h2>
          <HelmReleaseBadge rawJson={effectiveRawJson} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canGoBack && (
            <button
              onClick={onGoBack}
              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
              title={t('common.back', { defaultValue: 'Back' })}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-slate-800 text-xs shrink-0 gap-2">
        <div className="flex items-center gap-2">
          {([
            { id: 'info' as TabId, label: t('common.info', { defaultValue: 'Info' }), icon: Info },
            { id: 'yaml' as TabId, label: 'YAML', icon: FileCode },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md border transition-colors ${
                tab === id
                  ? 'border-slate-500 bg-slate-800 text-white'
                  : 'border-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
        {canDelete && (
          <button
            type="button"
            onClick={onDeleteClick}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md border border-red-700/60 bg-red-900/20 text-red-300 hover:bg-red-900/40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('common.deleteKind', { kind, defaultValue: 'Delete {{kind}}' })}
          </button>
        )}
      </div>
    </>
  )
}
