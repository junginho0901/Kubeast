// Pod 삭제 confirm 모달. ClusterView.tsx 에서 추출 (Phase 3.1.a).
//
// 부모가 모든 상태 (deleteTargetPod / force / error / isDeleting) 를 소유 +
// 콜백 (onForceChange / onClose / onConfirm) 으로 변경 위임. 이 컴포넌트는
// dialog UI 와 disabled 처리만 담당.

import { HelpCircle } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ModalOverlay } from '@/components/ModalOverlay'
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
  if (!pod) return null
  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg w-full max-w-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('podDeleteModal.title')}
      >
        <h2 className="text-xl font-bold text-white mb-4">{t('podDeleteModal.title')}</h2>
        <p className="text-slate-300 leading-relaxed">
          <Trans
            i18nKey="podDeleteModal.question"
            values={{ name: pod.name }}
            components={{ kbd: <kbd className="px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-100" /> }}
          />
        </p>
        <p className="text-slate-400 mt-3">
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

        {error && (
          <div className="mt-4 text-sm text-red-400">{error}</div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isDeleting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {t('podDeleteModal.confirm')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
