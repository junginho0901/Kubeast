import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  SummaryBadge,
  KeyValueTags,
  EventsTable,
  fmtRel,
} from './DetailCommon'

interface Props {
  name: string
  kind: 'MutatingWebhookConfiguration' | 'ValidatingWebhookConfiguration'
  rawJson?: Record<string, unknown>
}

export default function WebhookConfigInfo({ name, kind }: Props) {
  const isMutating = kind === 'MutatingWebhookConfiguration'

  const { data: desc, isLoading } = useQuery({
    queryKey: [isMutating ? 'mutatingwebhookconfiguration-describe' : 'validatingwebhookconfiguration-describe', name],
    queryFn: () =>
      isMutating
        ? api.describeMutatingWebhookConfiguration(name)
        : api.describeValidatingWebhookConfiguration(name),
    staleTime: 10_000,
    retry: 1,
  })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const webhooks: any[] = desc.webhooks || []
  const events: any[] = desc.events || []

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Webhooks" value={webhooks.length} color={webhooks.length > 0 ? 'green' : 'default'} />
        <SummaryBadge label="Type" value={isMutating ? 'Mutating' : 'Validating'} color={isMutating ? 'amber' : 'green'} />
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
          <InfoRow label="Resource Version" value={desc.resource_version || '-'} />
        </div>
      </InfoSection>

      {/* Webhooks Detail */}
      {webhooks.map((wh: any, idx: number) => (
        <InfoSection key={wh.name || idx} title={`Webhook: ${wh.name || `#${idx + 1}`}`}>
          <div className="space-y-2">
            <InfoRow label="Name" value={wh.name || '-'} />
            <InfoRow
              label="Admission Review Versions"
              value={
                Array.isArray(wh.admission_review_versions)
                  ? wh.admission_review_versions.join(', ')
                  : '-'
              }
            />
            <WebhookClientConfigRow clientConfig={wh.client_config} />
            <InfoRow label="Failure Policy" value={wh.failure_policy || '-'} />
            <InfoRow label="Match Policy" value={wh.match_policy || '-'} />
            <InfoRow label="Side Effects" value={wh.side_effects || '-'} />
            <InfoRow label="Timeout Seconds" value={wh.timeout_seconds ? String(wh.timeout_seconds) : '-'} />
            {isMutating && wh.reinvocation_policy && (
              <InfoRow label="Reinvocation Policy" value={wh.reinvocation_policy} />
            )}
            <SelectorRow label="Namespace Selector" selector={wh.namespace_selector} />
            <SelectorRow label="Object Selector" selector={wh.object_selector} />
            <WebhookRulesTable rules={wh.rules} />
          </div>
        </InfoSection>
      ))}

      {webhooks.length === 0 && (
        <InfoSection title="Webhooks">
          <div className="text-xs text-slate-400">-</div>
        </InfoSection>
      )}

      {/* Events */}
      <InfoSection title="Events">
        <EventsTable events={events} />
      </InfoSection>

      {/* Labels & Annotations */}
      <InfoSection title="Labels">
        <KeyValueTags data={desc.labels} />
      </InfoSection>

      <InfoSection title="Annotations">
        <KeyValueTags data={desc.annotations} />
      </InfoSection>
    </div>
  )
}

function WebhookClientConfigRow({ clientConfig }: { clientConfig?: any }) {
  if (!clientConfig) {
    return <InfoRow label="Client Config" value="-" />
  }

  if (clientConfig.url) {
    return <InfoRow label="Client Config (URL)" value={clientConfig.url} />
  }

  if (clientConfig.service) {
    const svc = clientConfig.service
    const value = `${svc.namespace || ''}/${svc.name || ''}${svc.path ? ` path: ${svc.path}` : ''}${svc.port ? ` port: ${svc.port}` : ''}`
    return (
      <InfoRow label="Client Config (Service)" value={value} />
    )
  }

  return <InfoRow label="Client Config" value="-" />
}

function SelectorRow({ label, selector }: { label: string; selector?: any }) {
  if (!selector) {
    return <InfoRow label={label} value="-" />
  }

  const parts: string[] = []

  if (selector.match_labels && Object.keys(selector.match_labels).length > 0) {
    for (const [k, v] of Object.entries(selector.match_labels)) {
      parts.push(`${k}=${v}`)
    }
  }

  if (Array.isArray(selector.match_expressions)) {
    for (const expr of selector.match_expressions) {
      const vals = Array.isArray(expr.values) ? expr.values.join(', ') : ''
      parts.push(`${expr.key} ${expr.operator} [${vals}]`)
    }
  }

  return (
    <InfoRow
      label={label}
      value={
        parts.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {parts.map((p) => (
              <span key={p} className="inline-flex px-2 py-0.5 rounded bg-slate-700/60 text-xs text-slate-200 break-all">
                {p}
              </span>
            ))}
          </div>
        ) : (
          '-'
        )
      }
    />
  )
}

function WebhookRulesTable({ rules }: { rules?: any[] }) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return <InfoRow label="Rules" value="-" />
  }

  return (
    <div className="mt-2">
      <p className="text-[11px] font-medium text-slate-400 mb-1">Rules</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border border-slate-700 rounded">
          <thead>
            <tr className="bg-slate-800/60 text-slate-400">
              <th className="text-left px-2 py-1.5">API Groups</th>
              <th className="text-left px-2 py-1.5">API Versions</th>
              <th className="text-left px-2 py-1.5">Operations</th>
              <th className="text-left px-2 py-1.5">Resources</th>
              <th className="text-left px-2 py-1.5">Scope</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {rules.map((rule, idx) => (
              <tr key={idx} className="text-slate-200">
                <td className="px-2 py-1.5 break-words whitespace-pre-wrap">
                  {Array.isArray(rule.api_groups) ? rule.api_groups.map((g: string) => g || '""').join(', ') : '-'}
                </td>
                <td className="px-2 py-1.5 break-words whitespace-pre-wrap">
                  {Array.isArray(rule.api_versions) ? rule.api_versions.join(', ') : '-'}
                </td>
                <td className="px-2 py-1.5 break-words whitespace-pre-wrap">
                  {Array.isArray(rule.operations) ? rule.operations.join(', ') : '-'}
                </td>
                <td className="px-2 py-1.5 break-words whitespace-pre-wrap">
                  {Array.isArray(rule.resources) ? rule.resources.join(', ') : '-'}
                </td>
                <td className="px-2 py-1.5">{rule.scope || '*'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
