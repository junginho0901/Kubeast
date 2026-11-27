// ResourceDetailDrawer 의 Header (제목 / 닫기 / 뒤로가기 / Helm 배지) +
// Tabs (Info/YAML + Delete 버튼). ResourceDetailDrawer.tsx 에서 추출
// (Phase 3.3.d).
//
// props 가 많은 이유: tab 상태 / 삭제 버튼 콜백 / 닫기·뒤로가기 lifecycle
// 이 모두 부모 (drawer) 가 관리하기 때문. 구조만 분리하는 thin presentational.

import type { RefObject } from 'react'
import type { TFunction } from 'i18next'
import { ArrowLeft, X, Info, FileCode, Trash2 } from 'lucide-react'
import { kindIconComponent } from '@/components/kindIcons'
import { TabId } from './utils'
import { HelmReleaseBadge } from './HelmReleaseBadge'
import { ArgoBadge } from './ArgoBadge'
import type { ArgoManaged } from './gitops'

interface Props {
  kind: string
  displayKind: string
  argo?: { managed: ArgoManaged | null; url: string | null; blocked: boolean }
  ns: string | null | undefined
  name: string
  effectiveRawJson: any
  canGoBack: boolean
  canDelete: boolean
  tab: TabId
  // the title takes the focus as the drawer opens (drawerFocus)
  titleRef?: RefObject<HTMLHeadingElement | null>
  // the kind (`<labelId>-kind`) and the title (`<labelId>-title`) name the drawer's dialog
  labelId?: string
  onClose: () => void
  onGoBack: () => void
  onTabChange: (tab: TabId) => void
  onDeleteClick: () => void
  t: TFunction
}

export function ResourceDetailHeader({
  kind,
  displayKind,
  argo,
  ns,
  name,
  effectiveRawJson,
  canGoBack,
  canDelete,
  tab,
  titleRef,
  labelId,
  onClose,
  onGoBack,
  onTabChange,
  onDeleteClick,
  t,
}: Props) {
  const KindIcon = kindIconComponent(kind)
  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-hairline shrink-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <KindIcon className="w-4 h-4 text-slate-400 shrink-0" aria-hidden />
            <span id={labelId && `${labelId}-kind`} className="text-xs text-slate-300 font-medium">{displayKind}</span>
            {ns && <span className="text-xs text-slate-500 break-all">{ns}</span>}
          </div>
          <h2
            ref={titleRef}
            id={labelId && `${labelId}-title`}
            tabIndex={-1}
            className="text-lg font-semibold text-ink truncate focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
            title={name}
          >
            {name}
          </h2>
          <HelmReleaseBadge rawJson={effectiveRawJson} />
          {argo && <ArgoBadge argo={argo.managed} url={argo.url} blocked={argo.blocked} />}
        </div>
        <div className="flex items-center gap-5 shrink-0">
          {canGoBack && (
            <button
              onClick={onGoBack}
              className="text-slate-400 hover:text-ink p-1 rounded-lg hover:bg-slate-700 transition-colors hit-area-40"
              title={t('common.back', { defaultValue: 'Back' })}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-ink p-1 rounded-lg hover:bg-slate-700 hit-area-40" aria-label={t('common.close', { defaultValue: 'Close' })}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between px-5 py-2 border-b border-hairline text-xs shrink-0 gap-2">
        {/* as tall as the Delete button, so the row does not move while the cluster is asked or when it is hidden */}
        <div className="flex items-center gap-2 min-h-7.5">
          {([
            { id: 'info' as TabId, label: t('common.info', { defaultValue: 'Info' }), icon: Info },
            { id: 'yaml' as TabId, label: 'YAML', icon: FileCode },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              aria-pressed={tab === id}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg border transition-colors ${
                tab === id
                  ? 'border-primary-400 bg-slate-800 text-primary-400'
                  : 'border-transparent text-slate-400 hover:bg-slate-800 hover:text-ink'
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
            className="btn-row-danger"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('common.deleteKind', { kind: displayKind, defaultValue: 'Delete {{kind}}' })}
          </button>
        )}
      </div>
    </>
  )
}
