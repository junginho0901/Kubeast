import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import type { PolicyReportResource } from '@/services/api/types'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { policyReportsEnabled } from '@/utils/features'
import { InfoSection, NoneText } from './DetailCommon'

// "Policy violations": the fail / warn / error rows the cluster's policy reports hold about this
// resource (a workload's rows include its pods). Nothing is shown when the feature is off or the
// cluster has no PolicyReport CRD.

const RESULT_BADGE: Record<string, string> = { fail: 'badge-error', error: 'badge-error', warn: 'badge-warning' }

export default function PolicyViolations({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const on = policyReportsEnabled(useClusterFeatures().data)
  const status = useQuery({
    queryKey: ['cluster', 'policyreports', 'status'],
    queryFn: () => api.getPolicyReportStatus(),
    enabled: on,
    staleTime: 60_000,
    retry: false,
  })
  const installed = status.data?.installed === true
  const { data } = useQuery({
    queryKey: ['cluster', 'policyreports', 'resource', namespace, kind, name],
    queryFn: () => api.getResourcePolicyReports(namespace, kind, name),
    enabled: on && installed && !!namespace,
    retry: false,
  })
  if (!on || !installed || !data || Array.isArray(data)) return null
  const report = data as PolicyReportResource
  const rows = report.rows.filter((r) => r.result === 'fail' || r.result === 'warn' || r.result === 'error')
  return (
    <InfoSection title="Policy violations">
      {rows.length === 0 ? (
        <div data-testid="policy-violations-none"><NoneText /></div>
      ) : (
        <table className="w-full text-xs" data-testid="policy-violations">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.result', 'Result')}</th>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.policy', 'Policy')}</th>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.severity', 'Severity')}</th>
              {kind !== 'Pod' && <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.resource', 'Resource')}</th>}
              <th className="text-left py-1 font-medium">{tr('policyReports.table.message', 'Message')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r, i) => (
              <tr key={`${r.report}/${r.policy}/${r.rule}/${i}`} data-testid="policy-violation-row" className="text-slate-200 align-top">
                <td className="py-1.5 pr-3"><span className={`badge ${RESULT_BADGE[r.result] || 'badge-neutral'}`}>{tr(`policyReports.result.${r.result}`, r.result)}</span></td>
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{r.policy}{r.rule ? <span className="text-slate-500">/{r.rule}</span> : null}</td>
                <td className="py-1.5 pr-3">{r.severity || '-'}</td>
                {kind !== 'Pod' && <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{r.kind}/{r.name}</td>}
                <td className="py-1.5 text-slate-300 break-words">{r.message || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </InfoSection>
  )
}
