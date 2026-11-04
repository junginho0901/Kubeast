import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { BackendTLSPolicyInfo as BackendTLSPolicyRow } from '@/services/api'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, NoneText, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { formatParentRef } from './gatewayDetail'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

// the list's row (gatewayrow.Policy) with the object's metadata and events, spec.validation and status.ancestors
type BackendTLSPolicyDescribe = BackendTLSPolicyRow & {
  validation?: Record<string, any>
  ancestors?: Array<Record<string, any>>
  events?: Array<Record<string, unknown>>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

export default function BackendTLSPolicyInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['backendtlspolicy-describe', namespace, name],
    queryFn: () => api.describeBackendTLSPolicy(namespace as string, name) as Promise<BackendTLSPolicyDescribe>,
    enabled,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'BackendTLSPolicy', name, namespace, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>

  const targetRefs = Array.isArray(describe?.target_refs)
    ? describe.target_refs
    : (Array.isArray(spec?.targetRefs) ? (spec.targetRefs as Array<Record<string, any>>) : [])

  const validation = describe?.validation ?? (spec?.validation as Record<string, any> | undefined)

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const ancestors = Array.isArray(describe?.ancestors) ? describe.ancestors : []
  const events = Array.isArray(describe?.events) ? describe.events : []

  return (
    <>
      <InfoSection title="BackendTLSPolicy Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading details...</Tx></p>}
        {isError && <p className="text-xs text-red-400 mb-2"><Tx>Failed to load describe data. Showing summary from list.</Tx></p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Target Refs" value={targetRefs.length} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Target Refs">
        {targetRefs.length === 0 ? (
          <p className="text-xs text-slate-400"><NoneText className="" /></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1 w-[25%]">Group</Th>
                  <Th className="text-left py-1 w-[25%]">Kind</Th>
                  <Th className="text-left py-1 w-[30%]">Name</Th>
                  <Th className="text-left py-1 w-[20%]">Section</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {targetRefs.map((ref: Record<string, any>, idx: number) => (
                  <tr key={`ref-${idx}`} className="text-slate-200">
                    <td className="py-1 pr-2 wrap-break-word">{text(ref.group)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(ref.kind)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(ref.name)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(ref.section_name || ref.sectionName)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      {validation && (
        <InfoSection title="TLS Validation">
          <div className="space-y-2">
            <InfoRow label="Hostname" value={text(validation.hostname)} />
            <InfoRow label="Well-Known CA Certificates" value={text(validation.well_known_ca_certificates || validation.wellKnownCACertificates)} />
            {Array.isArray(validation.ca_certificate_refs || validation.caCertificateRefs) && (
              <>
                <p className="text-xs text-slate-400 mt-2 font-medium"><Tx>CA Certificate Refs</Tx></p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs table-fixed min-w-[300px]">
                    <thead className="text-slate-400">
                      <tr>
                        <Th className="text-left py-1 w-[30%]">Group</Th>
                        <Th className="text-left py-1 w-[30%]">Kind</Th>
                        <Th className="text-left py-1 w-[40%]">Name</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {(validation.ca_certificate_refs || validation.caCertificateRefs || []).map((cr: Record<string, any>, idx: number) => (
                        <tr key={`cert-${idx}`} className="text-slate-200">
                          <td className="py-1 pr-2 wrap-break-word">{text(cr.group)}</td>
                          <td className="py-1 pr-2 wrap-break-word">{text(cr.kind)}</td>
                          <td className="py-1 pr-2 wrap-break-word">{text(cr.name)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </InfoSection>
      )}

      {ancestors.length > 0 && (
        <InfoSection title="Status">
          <div className="space-y-3">
            {ancestors.map((ancestor: Record<string, any>, idx: number) => (
              <div key={`ancestor-${idx}`} className="rounded-sm border border-slate-800 p-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mb-2">
                  <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Controller:</Tx></span> {text(ancestor?.controllerName)}</div>
                  <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Ancestor:</Tx></span> {formatParentRef(ancestor?.ancestorRef || {})}</div>
                </div>
                <ConditionsTable conditions={Array.isArray(ancestor?.conditions) ? ancestor.conditions : []} />
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      <InfoSection title="Events">
        <EventsTable events={events} />
      </InfoSection>

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
    </>
  )
}
