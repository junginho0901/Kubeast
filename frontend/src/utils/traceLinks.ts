// Links to a trace backend (chart features.tracing). Kubeast stores no traces: it fills the configured URL
// templates — {{traceId}} {{cluster}} {{namespace}} {{pod}} {{container}} {{service}} — with URL-encoded values.

export type TraceVars = Partial<Record<'traceId' | 'cluster' | 'namespace' | 'pod' | 'container' | 'service', string>>

// The template with its placeholders filled, or null: no template, a placeholder without a value (the link
// would point somewhere else), or a result that is not an http(s) URL.
export function fillTraceTemplate(template: string | undefined, vars: TraceVars): string | null {
  if (!template) return null
  let missing = false
  const url = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = (vars as Record<string, string | undefined>)[name]
    if (!v) {
      missing = true
      return ''
    }
    return encodeURIComponent(v)
  })
  if (missing || !/^https?:\/\//i.test(url)) return null
  return url
}

interface PodMeta {
  name: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{ kind?: string; name?: string }>
}

// The OpenTelemetry service.name of a Pod (semantic conventions, "k8s attributes"): the
// resource.opentelemetry.io/service.name annotation, app.kubernetes.io/instance, app.kubernetes.io/name, then
// the owning Deployment (a ReplicaSet without its pod-template-hash), ReplicaSet, StatefulSet, DaemonSet, Job,
// then the Pod.
export function podServiceName(pod: PodMeta): string {
  const labels = pod.labels ?? {}
  const fromMeta =
    pod.annotations?.['resource.opentelemetry.io/service.name'] || labels['app.kubernetes.io/instance'] || labels['app.kubernetes.io/name']
  if (fromMeta) return fromMeta
  const owners = pod.ownerReferences ?? []
  const rs = owners.find((o) => o.kind === 'ReplicaSet')?.name
  const hash = labels['pod-template-hash']
  if (rs && hash && rs.endsWith(`-${hash}`)) return rs.slice(0, -(hash.length + 1))
  for (const kind of ['ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job']) {
    const owner = owners.find((o) => o.kind === kind)?.name
    if (owner) return owner
  }
  return pod.name
}
