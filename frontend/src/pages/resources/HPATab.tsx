// Resources 페이지의 HPA 탭. Resources.tsx 에서 추출 (Phase 3.5.c).
//
// Horizontal Pod Autoscaler 의 메트릭/conditions/scaling 상태 분석 + 표시.
// metricsMissing / desiredBelowMin / scalingLimited 등 미세 분기 많아 가장
// 복잡한 카드. 부모는 filteredHPAs + hpasError 만 prop 으로 전달.

interface Props {
  filteredHPAs: any[]
  hpasError: unknown
}

export function HPATab({ filteredHPAs, hpasError }: Props) {
  return (
    <div className="space-y-4">
        {!!hpasError && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-200">
            HPA 조회에 실패했습니다. (클러스터 권한/버전에 따라 불가할 수 있습니다)
          </div>
        )}
        {filteredHPAs.map((hpa: any) => {
          const conditions: any[] = Array.isArray(hpa.conditions) ? hpa.conditions : []
          const metrics: any[] = Array.isArray(hpa.metrics) ? hpa.metrics : []
      
          const getCond = (t: string) => conditions.find((c) => c?.type === t)
          const scalingActive = getCond('ScalingActive')
          const ableToScale = getCond('AbleToScale')
          const scalingLimited = getCond('ScalingLimited')
      
          const desired = typeof hpa.desired_replicas === 'number' ? hpa.desired_replicas : null
          const min = typeof hpa.min_replicas === 'number' ? hpa.min_replicas : 0
          const desiredBelowMin = desired !== null && min > 0 && desired < min
      
          const metricsMissing = conditions.some((c) => {
            const reason = String(c?.reason || '')
            const msg = String(c?.message || '').toLowerCase()
            if (reason.includes('FailedGetResourceMetric')) return true
            if (reason.includes('FailedGetMetrics')) return true
            if (msg.includes('no metrics returned')) return true
            if (msg.includes('unable to get metrics')) return true
            if (msg.includes('metrics api')) return true
            return false
          })
      
          const desiredPrimary = metricsMissing
            ? 'unavailable'
            : (hpa.desired_replicas ?? '-')
          const desiredSecondary = metricsMissing ? '(metrics missing)' : null
      
          const hasBadCond = conditions.some((c) => c?.status && c.status !== 'True')
          const isLimited = (scalingLimited?.status ?? 'False') === 'True'
      
          const isHealthy =
            !hasBadCond &&
            !desiredBelowMin &&
            (scalingActive?.status ?? 'True') === 'True' &&
            (ableToScale?.status ?? 'True') === 'True' &&
            !isLimited
      
          const badge = isHealthy ? 'badge-success' : isLimited ? 'badge-warning' : 'badge-warning'
          const badgeText = isHealthy ? 'Healthy' : isLimited ? 'Limited' : 'Check'
      
          const formatMetric = (m: any) => {
            const type = m?.type || '-'
            const resource = m?.resource ? String(m.resource) : null
            const target = m?.target !== undefined && m?.target !== null ? String(m.target) : null
            if (resource && target) return `${type}: ${resource} target=${target}`
            if (resource) return `${type}: ${resource}`
            return `${type}`
          }
      
          const sortedConditions = conditions
            .slice()
            .sort((a, b) => {
              const aBad = a?.status && a.status !== 'True' ? 0 : 1
              const bBad = b?.status && b.status !== 'True' ? 0 : 1
              if (aBad !== bBad) return aBad - bBad
              return String(a?.type || '').localeCompare(String(b?.type || ''))
            })
      
          const shownConditions = sortedConditions.slice(0, 4)
          const hiddenCondCount = Math.max(0, sortedConditions.length - shownConditions.length)
          return (
            <div key={hpa.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{hpa.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">Target: {hpa.target_ref}</p>
                </div>
                <span className={`badge ${badge}`}>{badgeText}</span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Min</p>
                  <p className="text-lg font-bold text-white">{hpa.min_replicas ?? '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Max</p>
                  <p className="text-lg font-bold text-white">{hpa.max_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Current</p>
                  <p className="text-lg font-bold text-white">{hpa.current_replicas ?? '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Desired</p>
                  <p
                    className="text-lg font-bold text-white font-mono truncate"
                    title={desiredSecondary ? `${desiredPrimary} ${desiredSecondary}` : String(desiredPrimary)}
                  >
                    {desiredPrimary}
                  </p>
                  {desiredSecondary && (
                    <p className="mt-0.5 text-xs text-slate-400 font-mono">{desiredSecondary}</p>
                  )}
                </div>
              </div>
      
              {!isHealthy && metricsMissing && (
                <div className="mt-3 text-xs text-yellow-200 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  Desired 계산 불가: metrics-server/metrics API에서 메트릭을 받지 못했습니다.
                </div>
              )}
      
              {!isHealthy && !metricsMissing && desiredBelowMin && (
                <div className="mt-3 text-xs text-yellow-200 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  Desired({desired})가 minReplicas({min})보다 작습니다. 조건/메트릭을 확인하세요.
                </div>
              )}
      
              {metrics.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-2">Metrics</p>
                  <div className="flex flex-wrap gap-2">
                    {metrics.map((m, idx) => (
                      <span key={idx} className="badge badge-info font-mono">
                        {formatMetric(m)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
      
              <div className="mt-4">
                <p className="text-xs text-slate-400 mb-2">Conditions</p>
                {shownConditions.length === 0 ? (
                  <div className="text-sm text-slate-500">(없음)</div>
                ) : (
                  <div className="space-y-2">
                    {shownConditions.map((c, idx) => {
                      const isBad = c?.status && c.status !== 'True'
                      const boxClass = isBad
                        ? 'bg-red-500/10 border border-red-500/30'
                        : 'bg-slate-900/40 border border-slate-700'
                      return (
                        <div key={idx} className={`rounded-lg p-3 ${boxClass}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm text-white font-mono break-words">
                                {c?.type || '-'}: {c?.status ?? '-'}
                              </div>
                              {(c?.reason || c?.message) && (
                                <div className="mt-1 text-xs text-slate-300 break-words">
                                  {c?.reason ? `[${c.reason}] ` : ''}
                                  {c?.message || ''}
                                </div>
                              )}
                            </div>
                            {c?.last_transition_time && (
                              <div className="text-[11px] text-slate-500 whitespace-nowrap">
                                {new Date(c.last_transition_time).toLocaleString('ko-KR')}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {hiddenCondCount > 0 && (
                      <div className="text-xs text-slate-500">…(+{hiddenCondCount} more)</div>
                    )}
                  </div>
                )}
              </div>
      
              {hpa.last_scale_time && (
                <p className="mt-3 text-xs text-slate-500">LastScale: {new Date(hpa.last_scale_time).toLocaleString('ko-KR')}</p>
              )}
            </div>
          )
        })}
        {filteredHPAs.length === 0 && (
          <div className="card">
            <div className="text-slate-400">(없음)</div>
          </div>
        )}
    </div>
  )
}
