import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { ExternalLink, Siren } from 'lucide-react'

import type { Investigation } from '@/services/api/investigations'
import { useAIContext } from '@/hooks/useAIContext'
import { ModalFrame } from '@/components/ModalFrame'
import { REMARK_PLUGINS } from '@/utils/markdown'
import { formatWhen } from '@/pages/admin/accessRequestFormat'
import { duration, severityClass, statusClass } from '@/utils/investigationFormat'

// One alert investigation report (Admin → Investigations, and the Alerts inbox for whoever reads that cluster).
// Every fetch writes ai.investigation.view server-side, so it is not retried. The report text came from a model
// that read an external alert, so it is rendered as Markdown without raw HTML.

export default function InvestigationReportModal({ id, load, onClose }: {
  id: string
  // where the report comes from: the admin list or the alert's inbox row
  load: () => Promise<Investigation>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  // no retry: a 403/404/503 is the answer, and every fetch writes an audit row
  const { data, isLoading, error } = useQuery<Investigation>({
    queryKey: ['investigations', 'one', id],
    queryFn: load,
    retry: false,
    staleTime: Infinity,
  })
  useAIContext(data ? {
    source: 'InvestigationModal',
    summary: `알림 조사 보고서 — ${data.alertname} (${data.cluster}${data.namespace ? ` / ${data.namespace}` : ''}, ${data.status})`,
    data: {
      alertname: data.alertname, cluster: data.cluster, namespace: data.namespace, severity: data.severity, status: data.status,
      labels: data.labels, received_at: data.received_at, model: data.model, iterations: data.iterations,
      tool_calls: data.tool_calls.map((c) => ({ tool: c.tool, args: c.args, error: c.error })),
      error: data.error || undefined, report: data.report.slice(0, 4096),
    },
  } : null, [data])
  // The investigator has one identity; the first call that reached the cluster shows it.
  const ranAs = data?.tool_calls.find((c) => c.access?.impersonation)?.access

  return (
    <ModalFrame
      title={data ? data.alertname || id : tr('investigations.report', 'Report')}
      subtitle={data ? `${data.cluster}${data.namespace ? ' / ' + data.namespace : ''} · ${formatWhen(data.received_at)}` : undefined}
      icon={<Siren className="w-5 h-5 text-primary-400" />}
      size="lg"
      body="scroll"
      onClose={onClose}
      testId="investigation-modal"
      footer={
        <button type="button" onClick={onClose} className="btn btn-secondary">
          {tr('common.close', 'Close')}
        </button>
      }
    >
      {isLoading && <div className="py-6 text-center text-slate-500">{tr('investigations.loading', 'Loading…')}</div>}
      {error && (
        <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200" data-testid="investigation-error">
          {tr('investigations.loadFailed', 'The report could not be opened.')}
        </div>
      )}
      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400" data-testid="investigation-meta">
            <span>{tr('investigations.meta.status', 'Status')}: <span className={`rounded-sm border px-1.5 py-0.5 ${statusClass[data.status] ?? ''}`}>{tr(`investigations.status.${data.status}`, data.status)}</span></span>
            <span>{tr('investigations.meta.severity', 'Severity')}: <span className={severityClass[data.severity] ?? 'text-slate-300'}>{data.severity || '-'}</span></span>
            {data.model && <span>{tr('investigations.meta.model', 'Model')}: <span className="text-slate-300">{data.model}</span></span>}
            <span>{tr('investigations.meta.tokens', 'Tokens')}: <span className="text-slate-300">{data.prompt_tokens ?? '-'} + {data.completion_tokens ?? '-'}</span></span>
            <span>{tr('investigations.meta.steps', 'Model calls')}: <span className="text-slate-300">{data.iterations}</span></span>
            <span>{tr('investigations.meta.duration', 'Duration')}: <span className="text-slate-300">{duration(data.duration_ms)}</span></span>
            <span>{tr('investigations.meta.repeats', 'Repeats')}: <span className="text-slate-300">{data.repeat_count}</span></span>
          </div>

          {data.status === 'failed' && data.error && (
            <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200 break-words">{data.error}</div>
          )}
          {data.status === 'skipped' && (
            <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
              {tr('investigations.skipReason', 'Skipped: {{reason}}', { reason: data.skip_reason })}
            </div>
          )}

          {data.report && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('investigations.section.report', 'Report')}</h3>
              <div className="prose prose-invert prose-sm max-w-none rounded-lg border border-slate-700 bg-slate-950/40 px-4 py-3" data-testid="investigation-report">
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{data.report}</ReactMarkdown>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('investigations.section.alert', 'Alert')}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <dl className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
                {Object.entries(data.labels).map(([k, v]) => (
                  <div key={k} className="flex gap-2 py-0.5"><dt className="min-w-[110px] text-slate-500">{k}</dt><dd className="break-all font-mono text-slate-200">{v}</dd></div>
                ))}
              </dl>
              <dl className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
                {Object.entries(data.annotations).map(([k, v]) => (
                  <div key={k} className="flex gap-2 py-0.5"><dt className="min-w-[110px] text-slate-500">{k}</dt><dd className="break-words text-slate-200">{v}</dd></div>
                ))}
                {Object.keys(data.annotations).length === 0 && <div className="text-slate-500">{tr('investigations.noAnnotations', 'No annotations')}</div>}
              </dl>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-xs">
              {data.generator_url && (
                <a href={data.generator_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary-300 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" /> {tr('investigations.link.source', 'Source query')}
                </a>
              )}
              {data.alertmanager_url && (
                <a href={data.alertmanager_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary-300 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" /> {tr('investigations.link.sender', 'Alert sender')}
                </a>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {tr('investigations.section.tools', 'Tool calls ({{count}})', { count: data.tool_calls.length })}
            </h3>
            {ranAs && (
              <div className="mb-2 text-xs text-slate-400" data-testid="investigation-access">
                {tr('investigations.ranAs', 'Read the cluster as {{user}} (groups {{groups}}), read-only.', { user: ranAs.user, groups: (ranAs.groups || []).join(', ') })}
              </div>
            )}
            {data.tool_calls.length === 0 ? (
              <div className="text-xs text-slate-500">{tr('investigations.noTools', 'The model answered without calling a tool.')}</div>
            ) : (
              <table className="w-full text-xs" data-testid="investigation-tools">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">{tr('investigations.tool.name', 'Tool')}</th>
                    <th className="px-2 py-1 text-left">{tr('investigations.tool.args', 'Arguments')}</th>
                    <th className="px-2 py-1 text-right">{tr('investigations.tool.result', 'Result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tool_calls.map((c, i) => (
                    <tr key={i} className="border-t border-slate-800">
                      <td className="px-2 py-1 text-slate-500">{c.step}</td>
                      <td className="px-2 py-1 font-mono text-slate-200">{c.tool}</td>
                      <td className="px-2 py-1 font-mono text-slate-400"><span className="block max-w-[420px] truncate" title={JSON.stringify(c.args)}>{JSON.stringify(c.args)}</span></td>
                      <td className={`px-2 py-1 text-right whitespace-nowrap ${c.error ? 'text-red-300' : 'text-slate-400'}`} title={c.error || undefined}>
                        {c.error ? tr('investigations.tool.error', 'refused') : tr('investigations.tool.chars', '{{n}} chars', { n: c.result_chars ?? 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </ModalFrame>
  )
}
