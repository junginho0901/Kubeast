import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { useAIContext } from '@/hooks/useAIContext'
import { policyReportsEnabled } from '@/utils/features'
import { InfoSection, NoneText } from './DetailCommon'
import { violationsNameTheResource, violationsQuery, violationsView } from './violationsView'

// "Policy violations": the fail / warn / error rows the cluster's policy reports hold about this
// resource (a workload's rows include its pods; a namespaced resource's also come from the
// ClusterPolicyReports naming it, a cluster-scoped resource's from those alone). Nothing is shown when the
// feature is off or the cluster has no PolicyReport CRD; reports that could not be read say why.

const RESULT_BADGE: Record<string, string> = { fail: 'badge-error', error: 'badge-error', warn: 'badge-warning' }

export default function PolicyViolations({ kind, namespace, name, apiVersion }: { kind: string; namespace: string; name: string; apiVersion?: string }) {
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
  const resource = useQuery({
    ...violationsQuery(namespace, kind, name, apiVersion),
    enabled: on && installed,
    retry: false,
  })
  const view = violationsView(on, status, resource)
  const selectorError = view.show === 'rows' ? view.selectorError : undefined
  const clusterReportsError = view.show === 'rows' ? view.clusterReportsError : undefined
  useAIContext(view.show === 'rows' ? {
    source: 'PolicyViolations',
    summary: `Policy violations of ${kind} ${name}: ${view.rows.length}`,
    data: {
      rows: view.rows.map((r) => ({ result: r.result, policy: r.policy, rule: r.rule, severity: r.severity, kind: r.kind, name: r.name, message: r.message })),
      selector_error: selectorError,
      cluster_reports_error: clusterReportsError,
    },
  } : null, [view.show, view.show === 'rows' ? view.rows : null, selectorError, clusterReportsError, kind, name])
  if (view.show === 'nothing') return null
  const named = violationsNameTheResource(kind)
  return (
    <InfoSection title="Policy violations">
      {selectorError && (
        <p className="text-xs text-amber-300 mb-2" data-testid="policy-violations-selector-error">
          {tr('policyReports.selectorError', 'Results that pick resources by label could not be checked against this object: {{error}}', { error: selectorError })}
        </p>
      )}
      {clusterReportsError && (
        <p className="text-xs text-amber-300 mb-2" data-testid="policy-violations-cluster-error">
          {tr('policyReports.clusterReportsError', 'Results the cluster reports hold about this object are not listed: {{error}}', { error: clusterReportsError })}
        </p>
      )}
      {view.show === 'loading' ? (
        <span className="text-slate-400 text-xs" data-testid="policy-violations-loading">{tr('common.loading', 'Loading...')}</span>
      ) : view.show === 'error' ? (
        <p className="text-xs text-red-400" data-testid="policy-violations-error">
          {view.reason ? tr('policyReports.violationsError', 'Could not load the policy reports: {{error}}', { error: view.reason }) : tr('policyReports.loadError', 'Could not load the policy reports')}
        </p>
      ) : view.rows.length === 0 ? (
        <div data-testid="policy-violations-none"><NoneText /></div>
      ) : (
        <table className="w-full text-xs" data-testid="policy-violations">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.result', 'Result')}</th>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.policy', 'Policy')}</th>
              <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.severity', 'Severity')}</th>
              {named && <th className="text-left py-1 pr-3 font-medium">{tr('policyReports.table.resource', 'Resource')}</th>}
              <th className="text-left py-1 font-medium">{tr('policyReports.table.message', 'Message')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {view.rows.map((r, i) => (
              <tr key={`${r.report}/${r.policy}/${r.rule}/${i}`} data-testid="policy-violation-row" className="text-slate-200 align-top">
                <td className="py-1.5 pr-3"><span className={`badge ${RESULT_BADGE[r.result] || 'badge-neutral'}`}>{tr(`policyReports.result.${r.result}`, r.result)}</span></td>
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{r.policy}{r.rule ? <span className="text-slate-500">/{r.rule}</span> : null}</td>
                <td className="py-1.5 pr-3">{r.severity || '-'}</td>
                {named && <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{r.kind}/{r.name}</td>}
                <td className="py-1.5 text-slate-300 break-words">{r.message || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </InfoSection>
  )
}
