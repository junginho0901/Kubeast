// Pod 삭제 confirm 모달. ClusterView.tsx 에서 추출 (Phase 3.1.a).
//
// 부모가 모든 상태 (deleteTargetPod / force / error / isDeleting) 를 소유 +
// 콜백 (onForceChange / onClose / onConfirm) 으로 변경 위임. 이 컴포넌트는
// dialog UI 와 disabled 처리만 담당.

import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { TypeToConfirm, WarningBox } from '@/components/TypeToConfirm'
import { systemObject } from '@/components/resource-detail/systemObject'
import type { PodInfo } from '@/services/api'

interface Props {
  pod: PodInfo | null
  force: boolean
  error: string | null
  isDeleting: boolean
  onForceChange: (force: boolean) => void
  onClose: () => void
  onConfirm: () => void
}

export function PodDeleteModal({ pod, force, error, isDeleting, onForceChange, onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  // the typed name belongs to one pod: opening another starts empty
  const [typedFor, setTypedFor] = useState({ pod: '', value: '' })
  if (!pod) return null
  const typed = typedFor.pod === pod.name ? typedFor.value : ''
  const setTyped = (value: string) => setTypedFor({ pod: pod.name, value })
  const system = systemObject('Pod', pod.namespace, pod.name, { labels: pod.labels })
  const needsName = system.reasons.length > 0
  return (
    <ModalFrame
      size="sm"
      title={t('podDeleteModal.title')}
      onClose={onClose}
      busy={isDeleting}
      testId="pod-delete-dialog"
      footer={
        <>
          <button type="button" className={modalButton.cancel} onClick={onClose} disabled={isDeleting}>
            {t('common.cancel')}
          </button>
          <button type="button" className={modalButton.danger} onClick={onConfirm} disabled={isDeleting || (needsName && typed !== pod.name)}>
            {t('podDeleteModal.confirm')}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300 leading-relaxed break-keep">
        <Trans
          i18nKey="podDeleteModal.question"
          values={{ name: pod.name }}
          components={{ kbd: <kbd className="px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-100" /> }}
        />
      </p>
      <p className="text-sm text-slate-400 mt-3 break-keep">
        {t('podDeleteModal.warning')}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <input
          id="force-delete-checkbox"
          type="checkbox"
          checked={force}
          onChange={(event) => onForceChange(event.target.checked)}
          className="w-4 h-4 rounded-sm border-slate-500 bg-slate-700"
        />
        <label htmlFor="force-delete-checkbox" className="text-sm text-slate-300">
          {t('podDeleteModal.force')}
        </label>
        <span title={t('podDeleteModal.forceHint')}>
          <HelpCircle className="w-4 h-4 text-slate-400" />
        </span>
      </div>

      {needsName && (
        <>
          <WarningBox>
            {[t('common.systemObject.title', { defaultValue: 'This is a system object.' }),
              ...system.reasons.map((r) => `· ${t(`common.systemObject.${r}`)}`)].join('\n')}
          </WarningBox>
          <TypeToConfirm expected={pod.name} value={typed} onChange={setTyped} />
        </>
      )}

      {error && (
        <div className="mt-4 text-sm text-red-400">{error}</div>
      )}
    </ModalFrame>
  )
}
