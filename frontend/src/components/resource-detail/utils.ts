// ResourceDetailDrawer 의 유틸 + 상수.
// ResourceDetailDrawer.tsx 에서 추출 (Phase 3.3.a).
//
// 모두 순수 / 표현 컴포넌트라 instance state 없음. drawer 본체에서 import.
//
// 분류:
// - 상수: WORKLOAD_KINDS / NETWORK_KINDS / CONFIG_STORAGE_KINDS / SELF_LOADING_KINDS / UNRESOLVABLE_KINDS
// - 매핑: kindToPlural (Kind → API 복수형) — Kind 아이콘은 components/kindIcons.ts(사이드바와 공용)
// - Helm: extractHelmRelease (배지 컴포넌트는 HelmReleaseBadge.tsx)
// - Secret: decodeSecretYaml / encodeSecretYaml (data ↔ stringData base64 변환)

export type TabId = 'info' | 'yaml'

export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'])
export const NETWORK_KINDS = new Set(['Ingress', 'IngressClass', 'NetworkPolicy', 'Endpoints', 'EndpointSlice'])
export const CONFIG_STORAGE_KINDS = new Set(['PersistentVolume', 'PersistentVolumeClaim', 'StorageClass', 'VolumeAttachment'])

// Kinds whose info components fetch their own data and don't need injected rawJson.
export const SELF_LOADING_KINDS = new Set(['Node', 'Namespace'])
// CustomResourceInstance needs crd_name in rawJson and cannot be resolved via kindToPlural.
export const UNRESOLVABLE_KINDS = new Set(['CustomResourceInstance'])

// extractHelmRelease returns the owning Helm release coordinates
// (namespace, name) if the given raw resource JSON carries the
// meta.helm.sh annotations. The managed-by label is an extra signal
// but we do not require it — Helm sets the annotations even when a
// chart intentionally omits the label.
export function extractHelmRelease(
  rawJson: Record<string, unknown> | null | undefined,
): { namespace: string; name: string } | null {
  const metadata = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const name = annotations['meta.helm.sh/release-name']
  const ns = annotations['meta.helm.sh/release-namespace']
  if (typeof name !== 'string' || !name) return null
  if (typeof ns !== 'string' || !ns) return null
  return { namespace: ns, name }
}

export function decodeSecretYaml(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  let inDataBlock = false
  let dataIndent = -1
  for (const line of lines) {
    if (/^data:\s*$/.test(line)) {
      result.push('stringData:')
      inDataBlock = true
      dataIndent = -1
      continue
    }
    if (inDataBlock) {
      const match = line.match(/^(\s+)(\S+?):\s*(.+)$/)
      if (match) {
        const [, indent, key, value] = match
        if (dataIndent < 0) dataIndent = indent.length
        if (indent.length === dataIndent) {
          const trimmed = value.trim()
          try {
            const decoded = atob(trimmed)
            // Binary payloads (control characters other than \t \n \v \f \r) stay base64.
            const hasControlChar = Array.from(decoded).some((c) => {
              const code = c.charCodeAt(0)
              return code <= 0x08 || (code >= 0x0e && code <= 0x1f)
            })
            if (!hasControlChar) {
              const needsQuote = decoded.includes(':') || decoded.includes('#') || decoded.includes('\n') || decoded.includes('"') || decoded.includes("'") || decoded.startsWith(' ') || decoded.endsWith(' ')
              result.push(`${indent}${key}: ${needsQuote ? JSON.stringify(decoded) : decoded}`)
              continue
            }
          } catch { /* not valid base64, keep as-is */ }
          result.push(line)
          continue
        }
      }
      if (line.length > 0 && !line.startsWith(' ')) {
        inDataBlock = false
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

export function encodeSecretYaml(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  let inStringDataBlock = false
  let blockIndent = -1
  for (const line of lines) {
    if (/^stringData:\s*$/.test(line)) {
      result.push('data:')
      inStringDataBlock = true
      blockIndent = -1
      continue
    }
    if (inStringDataBlock) {
      const match = line.match(/^(\s+)(\S+?):\s*(.+)$/)
      if (match) {
        const [, indent, key, value] = match
        if (blockIndent < 0) blockIndent = indent.length
        if (indent.length === blockIndent) {
          let raw = value.trim()
          if (raw.startsWith('"') && raw.endsWith('"')) {
            try { raw = JSON.parse(raw) } catch { /* keep as-is */ }
          }
          result.push(`${indent}${key}: ${btoa(raw)}`)
          continue
        }
      }
      if (line.length > 0 && !line.startsWith(' ')) {
        inStringDataBlock = false
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

export function kindToPlural(kind: string): string {
  const map: Record<string, string> = {
    Pod: 'pod', Node: 'node', Namespace: 'namespace', Service: 'service',
    Deployment: 'deployment', ReplicaSet: 'replicaset', StatefulSet: 'statefulset',
    DaemonSet: 'daemonset', Job: 'job', CronJob: 'cronjob',
    ConfigMap: 'configmap', Secret: 'secret', Ingress: 'ingress',
    NetworkPolicy: 'networkpolicy', PersistentVolumeClaim: 'persistentvolumeclaim',
    PersistentVolume: 'persistentvolume', HorizontalPodAutoscaler: 'horizontalpodautoscaler',
    VerticalPodAutoscaler: 'verticalpodautoscaler',
    Endpoints: 'endpoints', EndpointSlice: 'endpointslice',
    IngressClass: 'ingressclass',
    Gateway: 'gateway',
    GatewayClass: 'gatewayclass',
    HTTPRoute: 'httproute',
    GRPCRoute: 'grpcroute',
    ReferenceGrant: 'referencegrant',
    BackendTLSPolicy: 'backendtlspolicy',
    DeviceClass: 'deviceclass',
    ResourceClaim: 'resourceclaim',
    ResourceClaimTemplate: 'resourceclaimtemplate',
    ResourceSlice: 'resourceslice',
    StorageClass: 'storageclass',
    VolumeAttachment: 'volumeattachment',
    ServiceAccount: 'serviceaccount',
    Role: 'role',
    RoleBinding: 'rolebinding',
    ClusterRole: 'clusterrole',
    ClusterRoleBinding: 'clusterrolebinding',
    PodDisruptionBudget: 'poddisruptionbudget',
    PriorityClass: 'priorityclass',
    RuntimeClass: 'runtimeclass',
    Lease: 'lease',
    ResourceQuota: 'resourcequota',
    LimitRange: 'limitrange',
    MutatingWebhookConfiguration: 'mutatingwebhookconfiguration',
    ValidatingWebhookConfiguration: 'validatingwebhookconfiguration',
    CustomResourceDefinition: 'customresourcedefinition',
    CustomResourceInstance: 'customresourceinstance',
  }
  return map[kind] ?? kind.toLowerCase()
}

