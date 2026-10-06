// Resources 페이지의 PDB 탭. Resources.tsx 에서 추출 (Phase 3.5.d).
//
// PodDisruptionBudget 카드. selector 로 매칭되는 Pod 수/ready 수/phase 분포를
// 직접 계산해 표시한다 (서버에서 안 내려주는 정보).
//
// "Pods 로 이동" 버튼은 부모의 setter 3개 (setPodLabelSelector / setSearchQuery /
// setActiveTab) 를 호출 — Resources 페이지 안에서만 의미 있어 prop 으로 받는다.

import { useTranslation } from 'react-i18next'
import type { ResourceType } from './types'

import { isPodReady, podMatchesSelector, selectorToString } from './podHelpers'

interface Props {
  filteredPDBs: any[]
  pdbsError: unknown
  podsForPdbs: any[] | undefined
  setPodLabelSelector: (s: string) => void
  setSearchQuery: (s: string) => void
  setActiveTab: (t: ResourceType) => void
}

export function PDBTab({
  filteredPDBs,
  pdbsError,
  podsForPdbs,
  setPodLabelSelector,
  setSearchQuery,
  setActiveTab,
}: Props) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      {!!pdbsError && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-200">
          {t('resourcesTabs.fetchFailed', { kind: 'PDB' })}
        </div>
      )}
      {filteredPDBs.map((pdb: any) => (
        <div key={pdb.name} className="card">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold text-white">{pdb.name}</h3>
              <p className="text-sm text-slate-400 mt-1">
                {pdb.min_available ? `minAvailable=${pdb.min_available}` : pdb.max_unavailable ? `maxUnavailable=${pdb.max_unavailable}` : 'min/max: -'}
              </p>
              {(() => {
                const selectorObj = pdb.selector || {}
                const matched = (podsForPdbs || []).filter((pod: any) => podMatchesSelector(pod, selectorObj))
                const matchedCount = matched.length
                const readyCount = matched.filter(isPodReady).length
                const phaseCounts = matched.reduce((acc: Record<string, number>, pod: any) => {
                  const phase = (pod?.phase || pod?.status || 'Unknown').toString()
                  acc[phase] = (acc[phase] || 0) + 1
                  return acc
                }, {})
                const phaseSummary = Object.entries(phaseCounts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(' · ')

                if (Object.keys(selectorObj).length === 0) {
                  return <p className="text-xs text-slate-500 mt-1">{t('resourcesTabs.pdb.noSelector')}</p>
                }

                return (
                  <p className="text-xs text-slate-500 mt-1 font-mono">
                    matchedPods: {matchedCount} · ready: {readyCount}{phaseSummary ? ` · phase: ${phaseSummary}` : ''}
                  </p>
                )
              })()}

              {(() => {
                const expected = Number(pdb.expected_pods || 0)
                const currentHealthy = Number(pdb.current_healthy || 0)
                const desiredHealthy = Number(pdb.desired_healthy || 0)
                const allowed = Number(pdb.disruptions_allowed || 0)

                if (expected === 0) {
                  return <p className="text-xs text-slate-400 mt-2">{t('resourcesTabs.pdb.noMatchingPods')}</p>
                }
                if (allowed > 0) {
                  return <p className="text-xs text-slate-400 mt-2">{t('resourcesTabs.pdb.allowed', { count: allowed })}</p>
                }
                if (currentHealthy < desiredHealthy) {
                  return (
                    <p className="text-xs text-yellow-200 mt-2">
                      {t('resourcesTabs.pdb.notProtectedBelow', { healthy: currentHealthy, desired: desiredHealthy })}
                    </p>
                  )
                }
                return <p className="text-xs text-yellow-200 mt-2">{t('resourcesTabs.pdb.notProtected')}</p>
              })()}
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className={`badge ${pdb.disruptions_allowed > 0 ? 'badge-success' : 'badge-warning'}`}>
                disruptionsAllowed: {pdb.disruptions_allowed}
              </span>
              <button
                type="button"
                onClick={() => {
                  const selector = selectorToString(pdb.selector || {})
                  setPodLabelSelector(selector)
                  setSearchQuery('')
                  setActiveTab('pods')
                }}
                disabled={!pdb.selector || Object.keys(pdb.selector).length === 0}
                className="text-xs text-slate-300 hover:text-white border border-slate-600 rounded-sm px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('resourcesTabs.pdb.filterTitle')}
              >
                {t('resourcesTabs.pdb.goToPods')}
              </button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-slate-400">CurrentHealthy</p>
              <p className="text-lg font-bold text-white">{pdb.current_healthy}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">DesiredHealthy</p>
              <p className="text-lg font-bold text-white">{pdb.desired_healthy}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">ExpectedPods</p>
              <p className="text-lg font-bold text-white">{pdb.expected_pods}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Selector</p>
              <p className="text-sm font-mono text-white truncate" title={Object.entries(pdb.selector || {}).map(([k, v]: any) => `${k}=${v}`).join(', ')}>
                {Object.entries(pdb.selector || {}).map(([k, v]: any) => `${k}=${v}`).join(', ') || '-'}
              </p>
            </div>
          </div>
        </div>
      ))}
      {filteredPDBs.length === 0 && (
        <div className="card">
          <div className="text-slate-400">{t('resourcesTabs.none')}</div>
        </div>
      )}
    </div>
  )
}
