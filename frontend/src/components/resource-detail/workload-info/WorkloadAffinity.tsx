import { InfoSection } from '../DetailCommon'
import { formatLabelSelector } from './workloadInfoFormatters'

interface Props {
  affinity: Record<string, any> | undefined
  topologySpreadConstraints: any[]
}

export default function WorkloadAffinity({ affinity, topologySpreadConstraints }: Props) {
  const hasAffinity = affinity && Object.keys(affinity).length > 0

  return (
    <>
      {hasAffinity && (
        <InfoSection title="Affinity">
          <div className="space-y-3">
            {affinity!.nodeAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Node Affinity</div>
                {affinity!.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity!.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms as any[]).map((term: any, tIdx: number) => (
                      <div key={`req-term-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        {Array.isArray(term.matchExpressions) && term.matchExpressions.map((expr: any, eIdx: number) => (
                          <div key={`req-expr-${eIdx}`}>
                            {expr.key || '?'} {expr.operator || '?'} [{Array.isArray(expr.values) ? expr.values.join(', ') : ''}]
                          </div>
                        ))}
                        {Array.isArray(term.matchFields) && term.matchFields.map((field: any, fIdx: number) => (
                          <div key={`req-field-${fIdx}`}>
                            {field.key || '?'} {field.operator || '?'} [{Array.isArray(field.values) ? field.values.join(', ') : ''}]
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity!.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity!.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity!.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        {Array.isArray(pref.preference?.matchExpressions) && pref.preference.matchExpressions.map((expr: any, eIdx: number) => (
                          <span key={`pref-expr-${eIdx}`}>
                            {expr.key || '?'} {expr.operator || '?'} [{Array.isArray(expr.values) ? expr.values.join(', ') : ''}]
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {affinity!.podAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Pod Affinity</div>
                {Array.isArray(affinity!.podAffinity.requiredDuringSchedulingIgnoredDuringExecution) && affinity!.podAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity!.podAffinity.requiredDuringSchedulingIgnoredDuringExecution as any[]).map((term: any, tIdx: number) => (
                      <div key={`pa-req-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        <div>topologyKey: {term.topologyKey || '-'}</div>
                        <div>selector: {formatLabelSelector(term.labelSelector)}</div>
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity!.podAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity!.podAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity!.podAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`pa-pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        topologyKey: {pref.podAffinityTerm?.topologyKey || '-'}, selector: {formatLabelSelector(pref.podAffinityTerm?.labelSelector)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {affinity!.podAntiAffinity && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-300">Pod Anti-Affinity</div>
                {Array.isArray(affinity!.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution) && affinity!.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Required</div>
                    {(affinity!.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution as any[]).map((term: any, tIdx: number) => (
                      <div key={`paa-req-${tIdx}`} className="text-xs text-slate-200 pl-2">
                        <div>topologyKey: {term.topologyKey || '-'}</div>
                        <div>selector: {formatLabelSelector(term.labelSelector)}</div>
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray(affinity!.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution) && affinity!.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Preferred</div>
                    {(affinity!.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution as any[]).map((pref: any, pIdx: number) => (
                      <div key={`paa-pref-${pIdx}`} className="text-xs text-slate-200 pl-2">
                        <span className="text-slate-400">weight={pref.weight ?? '?'}</span>{' '}
                        topologyKey: {pref.podAffinityTerm?.topologyKey || '-'}, selector: {formatLabelSelector(pref.podAffinityTerm?.labelSelector)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {topologySpreadConstraints.length > 0 && (
        <InfoSection title="Topology Spread Constraints">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="py-1.5 pr-3">Max Skew</th>
                  <th className="py-1.5 pr-3">Topology Key</th>
                  <th className="py-1.5 pr-3">When Unsatisfiable</th>
                  <th className="py-1.5">Label Selector</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {topologySpreadConstraints.map((tsc: any, idx: number) => (
                  <tr key={`tsc-${idx}`} className="border-b border-slate-800/50">
                    <td className="py-1.5 pr-3 font-mono">{tsc.maxSkew ?? '-'}</td>
                    <td className="py-1.5 pr-3 font-mono">{tsc.topologyKey || '-'}</td>
                    <td className="py-1.5 pr-3">{tsc.whenUnsatisfiable || '-'}</td>
                    <td className="py-1.5 font-mono">{formatLabelSelector(tsc.labelSelector)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}
    </>
  )
}
