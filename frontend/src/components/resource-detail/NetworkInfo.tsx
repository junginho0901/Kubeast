import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'
import { ResourceLink } from './ResourceLink'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

function renderConditionBadge(label: string, value: unknown) {
  const isOn = value === true
  const isUnknown = value == null
  const cls = isUnknown
    ? 'border-slate-700 bg-slate-800/70 text-slate-300'
    : isOn
      ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-300'
      : 'border-amber-700/60 bg-amber-900/20 text-amber-300'
  const text = isUnknown ? 'Unknown' : isOn ? 'True' : 'False'
  return <span className={`inline-flex items-center rounded px-2 py-0.5 border ${cls}`}>{label}: {text}</span>
}

export default function NetworkInfo({ name, namespace, kind, rawJson }: Props) {
  if (kind === 'Service') return <ServiceDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'Ingress') return <IngressDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'IngressClass') return <IngressClassDetail name={name} rawJson={rawJson} />
  if (kind === 'NetworkPolicy') return <NetworkPolicyDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'EndpointSlice') return <EndpointSliceDetail name={name} namespace={namespace} rawJson={rawJson} />
  return <EndpointDetail name={name} namespace={namespace} kind={kind} rawJson={rawJson} />
}

function ServiceDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const selector = (spec.selector ?? {}) as Record<string, string>
  const ports = (spec.ports ?? []) as any[]
  const externalIPs = (spec.externalIPs ?? []) as string[]
  const lbIngress = ((status.loadBalancer as any)?.ingress ?? []) as any[]

  return (
    <>
      <InfoSection title="Service Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={String(spec.type ?? 'ClusterIP')} />
          <InfoRow label="Cluster IP" value={String(spec.clusterIP ?? '-')} />
          {externalIPs.length > 0 && <InfoRow label="External IPs" value={externalIPs.join(', ')} />}
          {lbIngress.length > 0 && <InfoRow label="Load Balancer" value={lbIngress.map((i: any) => i.ip || i.hostname).join(', ')} />}
          <InfoRow label="Session Affinity" value={String(spec.sessionAffinity ?? 'None')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead className="text-slate-400"><tr><th className="text-left py-1">Name</th><th className="text-left py-1">Port</th><th className="text-left py-1">Target</th><th className="text-left py-1">Protocol</th>{spec.type === 'NodePort' && <th className="text-left py-1">NodePort</th>}</tr></thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p.name || '-'}</td>
                    <td className="py-1 pr-2">{p.port}</td>
                    <td className="py-1 pr-2">{p.targetPort ?? '-'}</td>
                    <td className="py-1 pr-2">{p.protocol || 'TCP'}</td>
                    {spec.type === 'NodePort' && <td className="py-1 pr-2">{p.nodePort ?? '-'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function IngressDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const rules = (spec.rules ?? []) as any[]
  const tls = (spec.tls ?? []) as any[]
  const defaultBackend = spec.defaultBackend as any
  const classSource = String(rawJson?.class_source ?? '-')
  const classController = String(rawJson?.class_controller ?? '-')
  const classDefaultRaw = rawJson?.class_is_default
  const classIsDefault = classDefaultRaw == null ? '-' : Boolean(classDefaultRaw) ? 'Yes' : 'No'
  const lbAddresses = (((status.loadBalancer as any)?.ingress ?? []) as any[])
    .map((a: any) => a?.ip || a?.hostname)
    .filter(Boolean)

  return (
    <>
      <InfoSection title="Ingress Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {spec.ingressClassName && <InfoRow label="Ingress Class" value={<ResourceLink kind="IngressClass" name={String(spec.ingressClassName)} />} />}
          {defaultBackend && (
            <InfoRow label="Default Backend" value={
              defaultBackend.service ? `${defaultBackend.service.name}:${defaultBackend.service.port?.number || defaultBackend.service.port?.name || ''}` : '-'
            } />
          )}
          {lbAddresses.length > 0 && <InfoRow label="Addresses" value={lbAddresses.join(', ')} />}
          <InfoRow label="Class Source" value={classSource} />
          <InfoRow label="Class Controller" value={classController} />
          <InfoRow label="Class Default" value={classIsDefault} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {tls.length > 0 && (
        <InfoSection title="TLS">
          <div className="space-y-1 text-xs">
            {tls.map((t: any, i: number) => (
              <div key={i} className="text-slate-200">
                <span className="text-slate-400">Secret:</span> {t.secretName || '-'} <span className="text-slate-400">→</span> {(t.hosts || []).join(', ')}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {rules.length > 0 && (
        <InfoSection title="Rules">
          <div className="space-y-3">
            {rules.map((rule: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-3">
                <p className="text-xs text-white font-medium mb-2">{rule.host || '*'}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-400"><tr><th className="text-left py-1">Path</th><th className="text-left py-1">Type</th><th className="text-left py-1">Backend</th></tr></thead>
                    <tbody className="divide-y divide-slate-800">
                      {(rule.http?.paths || []).map((path: any, pi: number) => (
                        <tr key={pi} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{path.path || '/'}</td>
                          <td className="py-1 pr-2">{path.pathType || 'Prefix'}</td>
                          <td className="py-1 pr-2">
                            {path.backend?.service?.name ? (
                              <><ResourceLink kind="Service" name={path.backend.service.name} namespace={namespace} />:{path.backend.service.port?.number || path.backend.service.port?.name || ''}</>
                            ) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function IngressClassDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const finalizers = (meta.finalizers ?? rawJson?.finalizers ?? []) as string[]
  const isDefault = rawJson?.is_default != null
    ? Boolean(rawJson?.is_default)
    : annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
  const params = (spec.parameters ?? rawJson?.parameters ?? null) as Record<string, unknown> | null
  const paramsText = params
    ? [
        params.kind ? String(params.kind) : null,
        (params.apiGroup ?? params.api_group) ? `.${String(params.apiGroup ?? params.api_group)}` : null,
        params.name ? `/${String(params.name)}` : null,
        params.scope ? ` (${String(params.scope)})` : null,
        params.namespace ? ` ns=${String(params.namespace)}` : null,
      ].filter(Boolean).join('')
    : '-'

  return (
    <>
      <InfoSection title="IngressClass Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Controller" value={String(spec.controller ?? rawJson?.controller ?? '-')} />
          <InfoRow label="Default" value={isDefault ? 'Yes' : 'No'} />
          <InfoRow label="Parameters" value={paramsText || '-'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {finalizers.length > 0 && (
        <InfoSection title="Finalizers">
          <div className="flex flex-wrap gap-1.5">
            {finalizers.map((f, i) => (
              <span key={`${f}-${i}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200">{f}</span>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}

function NetworkPolicyDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const finalizers = (meta.finalizers ?? rawJson?.finalizers ?? []) as string[]
  const podSelector = (spec.podSelector as any)?.matchLabels as Record<string, string> | undefined
  const ingress = (spec.ingress ?? []) as any[]
  const egress = (spec.egress ?? []) as any[]
  const policyTypes = (spec.policyTypes ?? []) as string[]

  const isDefaultDenyIngress = policyTypes.includes('Ingress') && (!spec.ingress || (Array.isArray(spec.ingress) && (spec.ingress as any[]).length === 0))
  const isDefaultDenyEgress = policyTypes.includes('Egress') && (!spec.egress || (Array.isArray(spec.egress) && (spec.egress as any[]).length === 0))

  const renderPeer = (peer: any) => {
    const parts: string[] = []
    if (peer.ipBlock) parts.push(`CIDR: ${peer.ipBlock.cidr}${peer.ipBlock.except ? ` (except ${peer.ipBlock.except.join(', ')})` : ''}`)
    if (peer.namespaceSelector?.matchLabels) parts.push(`ns: ${Object.entries(peer.namespaceSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}`)
    if (peer.podSelector?.matchLabels) parts.push(`pod: ${Object.entries(peer.podSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}`)
    return parts.join(' | ') || '*'
  }

  return (
    <>
      <InfoSection title="NetworkPolicy Info">
        {(isDefaultDenyIngress || isDefaultDenyEgress) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {isDefaultDenyIngress && <span className="badge badge-warning">Default Deny Ingress</span>}
            {isDefaultDenyEgress && <span className="badge badge-warning">Default Deny Egress</span>}
          </div>
        )}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Policy Types" value={policyTypes.join(', ') || '-'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {podSelector && Object.keys(podSelector).length > 0 && (
        <InfoSection title="Pod Selector">
          <KeyValueTags data={podSelector} />
        </InfoSection>
      )}

      {ingress.length > 0 && (
        <InfoSection title="Ingress Rules">
          <div className="space-y-2 text-xs">
            {ingress.map((rule: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                {rule.ports?.length > 0 && <div className="text-slate-400">Ports: {rule.ports.map((p: any) => `${p.port}/${p.protocol || 'TCP'}`).join(', ')}</div>}
                <div className="text-slate-200">From: {(rule.from || [{ ipBlock: { cidr: '0.0.0.0/0' } }]).map(renderPeer).join(' ; ')}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {egress.length > 0 && (
        <InfoSection title="Egress Rules">
          <div className="space-y-2 text-xs">
            {egress.map((rule: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                {rule.ports?.length > 0 && <div className="text-slate-400">Ports: {rule.ports.map((p: any) => `${p.port}/${p.protocol || 'TCP'}`).join(', ')}</div>}
                <div className="text-slate-200">To: {(rule.to || [{ ipBlock: { cidr: '0.0.0.0/0' } }]).map(renderPeer).join(' ; ')}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
      {finalizers.length > 0 && (
        <InfoSection title="Finalizers">
          <div className="flex flex-wrap gap-1.5">
            {finalizers.map((f, i) => (
              <span key={`${f}-${i}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200">{f}</span>
            ))}
          </div>
        </InfoSection>
      )}
    </>
  )
}

function EndpointSliceDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = ((rawJson?.labels as Record<string, string>) ?? (meta.labels as Record<string, string>) ?? {}) as Record<string, string>
  const annotations = ((rawJson?.annotations as Record<string, string>) ?? (meta.annotations as Record<string, string>) ?? {}) as Record<string, string>
  const endpoints = (rawJson?.endpoints ?? []) as any[]
  const ports = (rawJson?.ports ?? []) as any[]
  const addressType = String(rawJson?.address_type ?? rawJson?.addressType ?? '-')
  const serviceName = String(rawJson?.service_name ?? labels?.['kubernetes.io/service-name'] ?? '-')
  const managedBy = String(rawJson?.managed_by ?? labels?.['endpointslice.kubernetes.io/managed-by'] ?? '-')
  const total = Number(rawJson?.endpoints_total ?? endpoints.length ?? 0)
  const ready = Number(rawJson?.endpoints_ready ?? endpoints.filter((ep: any) => ep?.conditions?.ready !== false).length ?? 0)
  const notReady = Number(rawJson?.endpoints_not_ready ?? Math.max(total - ready, 0))

  return (
    <>
      <InfoSection title="EndpointSlice Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Address Type" value={addressType} />
          <InfoRow label="Service" value={serviceName} />
          <InfoRow label="Managed By" value={managedBy} />
          <InfoRow label="Endpoints (Ready / Total)" value={`${ready} / ${total}`} />
          <InfoRow label="Not Ready Endpoints" value={String(notReady)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[460px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Name</th>
                  <th className="text-left py-1">Port</th>
                  <th className="text-left py-1">Protocol</th>
                  <th className="text-left py-1">App Protocol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p?.name || '-'}</td>
                    <td className="py-1 pr-2">{p?.port ?? '-'}</td>
                    <td className="py-1 pr-2">{p?.protocol || 'TCP'}</td>
                    <td className="py-1 pr-2">{p?.app_protocol || p?.appProtocol || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {endpoints.length > 0 && (
        <InfoSection title="Endpoints">
          <div className="space-y-2">
            {endpoints.map((ep: any, i: number) => {
              const addresses = Array.isArray(ep?.addresses) ? ep.addresses : []
              const ref = ep?.target_ref || ep?.targetRef
              const refText = ref?.name ? `${ref?.kind || 'Target'}:${ref.name}` : '-'
              return (
                <div key={i} className="rounded border border-slate-800 p-3 space-y-2">
                  <div className="text-xs text-slate-200 break-all">
                    <span className="text-slate-400">Addresses:</span> {addresses.length > 0 ? addresses.join(', ') : '-'}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Hostname:</span> {ep?.hostname || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Node:</span> {ep?.node_name || ep?.nodeName || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Zone:</span> {ep?.zone || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">TargetRef:</span> {refText}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {renderConditionBadge('Ready', ep?.conditions?.ready)}
                    {renderConditionBadge('Serving', ep?.conditions?.serving)}
                    {renderConditionBadge('Terminating', ep?.conditions?.terminating)}
                  </div>
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}

function EndpointDetail({ name, namespace, kind, rawJson }: { name: string; namespace?: string; kind: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const subsets = (rawJson?.subsets ?? []) as any[]
  const endpoints = (rawJson?.endpoints ?? []) as any[]
  const readyCount = Number(rawJson?.ready_count ?? 0)
  const notReadyCount = Number(rawJson?.not_ready_count ?? 0)
  const readyAddresses = (rawJson?.ready_addresses ?? []) as string[]
  const notReadyAddresses = (rawJson?.not_ready_addresses ?? []) as string[]
  const readyTargets = (rawJson?.ready_targets ?? []) as any[]
  const notReadyTargets = (rawJson?.not_ready_targets ?? []) as any[]
  const ports = (rawJson?.ports ?? []) as any[]

  const renderTargets = (targets: any[], fallbackIps: string[], tone: 'ready' | 'notReady') => {
    if (!Array.isArray(targets) || targets.length === 0) {
      if (!Array.isArray(fallbackIps) || fallbackIps.length === 0) return <p className="text-xs text-slate-400">(none)</p>
      return <p className="text-xs text-slate-200 break-all">{fallbackIps.join(', ')}</p>
    }

    const borderTone = tone === 'ready' ? 'border-emerald-800/60 bg-emerald-900/10' : 'border-amber-800/60 bg-amber-900/10'
    return (
      <div className="space-y-1.5">
        {targets.map((t: any, i: number) => {
          const ref = t?.target_ref || t?.targetRef
          const refText = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : '(targetRef none)'
          const nodeText = t?.node_name ? `node=${t.node_name}` : null
          return (
            <div key={`${tone}-${i}`} className={`rounded border px-2 py-1.5 text-xs ${borderTone}`}>
              <p className="text-slate-200 font-mono break-all">{t?.ip || '-'}</p>
              <p className="text-slate-300 break-all">{refText}</p>
              {nodeText && <p className="text-slate-400">{nodeText}</p>}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <InfoSection title={`${kind} Info`}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Ready Addresses" value={String(readyCount)} />
          <InfoRow label="Not Ready Addresses" value={String(notReadyCount)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[360px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Name</th>
                  <th className="text-left py-1">Port</th>
                  <th className="text-left py-1">Protocol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p?.name || '-'}</td>
                    <td className="py-1 pr-2">{p?.port ?? '-'}</td>
                    <td className="py-1 pr-2">{p?.protocol || 'TCP'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {(readyTargets.length > 0 || readyAddresses.length > 0) && (
        <InfoSection title="Ready Targets">
          {renderTargets(readyTargets, readyAddresses, 'ready')}
        </InfoSection>
      )}

      {(notReadyTargets.length > 0 || notReadyAddresses.length > 0) && (
        <InfoSection title="Not Ready Targets">
          {renderTargets(notReadyTargets, notReadyAddresses, 'notReady')}
        </InfoSection>
      )}

      {subsets.length > 0 && (
        <InfoSection title="Subsets">
          <div className="space-y-2 text-xs">
            {subsets.map((s: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                <div className="text-slate-200">Addresses: {(s.addresses || []).map((a: any) => a.ip).join(', ') || '(none)'}</div>
                <div className="text-slate-400">Ports: {(s.ports || []).map((p: any) => `${p.name || ''}:${p.port}/${p.protocol || 'TCP'}`).join(', ') || '(none)'}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {endpoints.length > 0 && (
        <InfoSection title="Endpoints">
          <div className="space-y-2 text-xs">
            {endpoints.map((ep: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                <div className="text-slate-200">Addresses: {(ep.addresses || []).join(', ')}</div>
                <div className="text-slate-400">Conditions: ready={String(ep.conditions?.ready ?? '-')}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}
