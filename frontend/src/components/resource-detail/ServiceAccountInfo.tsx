import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  EventsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'
import { ResourceLink } from './ResourceLink'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function ServiceAccountInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const { data: describe, isLoading } = useQuery({
    queryKey: ['serviceaccount-describe', namespace, name],
    queryFn: () => api.describeServiceAccount(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const secretsList = Array.isArray(describe?.secrets_list) ? describe.secrets_list as string[] : []
  const imagePullSecrets = Array.isArray(describe?.image_pull_secrets) ? describe.image_pull_secrets as string[] : []
  const automount = describe?.automount_service_account_token
  const events = Array.isArray(describe?.events) ? describe.events : []

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value="ServiceAccount" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
        </div>
      </InfoSection>

      <InfoSection title="ServiceAccount Details">
        <div className="space-y-2">
          {automount != null && <InfoRow label="Automount Token" value={automount ? 'Yes' : 'No'} />}
          <InfoRow label="Secrets" value={String(describe?.secrets ?? 0)} />
        </div>
      </InfoSection>

      {secretsList.length > 0 && (
        <InfoSection title="Secrets">
          <div className="space-y-1 text-xs text-slate-200">
            {secretsList.map((s: string) => (
              <div key={s}><ResourceLink kind="Secret" name={s} namespace={namespace} /></div>
            ))}
          </div>
        </InfoSection>
      )}

      {imagePullSecrets.length > 0 && (
        <InfoSection title="Image Pull Secrets">
          <div className="space-y-1 text-xs text-slate-200">
            {imagePullSecrets.map((s: string) => (
              <div key={s} className="font-mono">{s}</div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}

      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}
    </div>
  )
}
