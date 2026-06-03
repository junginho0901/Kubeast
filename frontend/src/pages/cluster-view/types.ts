// ClusterView 전용 타입 + Pod 메인 컨테이너 추출 휴리스틱.
// 사이드카(istio/envoy/linkerd/vault)를 제외하고 Pod 이름의 base 와 매칭되는
// 컨테이너를 메인으로 본다. 매칭 실패 시 첫 비-사이드카 컨테이너 → 첫 컨테이너.

export interface PodDetail {
  name: string
  namespace: string
  node: string
  status: string
  phase: string
  restart_count: number
  created_at: string
  containers: Array<{
    name: string
    image: string
    ready: boolean
    state: {
      waiting?: { reason?: string | null; message?: string | null }
      terminated?: { reason?: string | null; message?: string | null; exit_code?: number | null }
      running?: { started_at?: string | null }
    } | null
    restart_count: number
  }>
}

const SIDECAR_PATTERNS = ['istio-proxy', 'istio-init', 'envoy', 'linkerd-proxy', 'vault-agent']

export function pickMainContainer(pod: { name: string; containers?: Array<{ name: string }> }): string {
  const containers = pod.containers ?? []
  if (containers.length === 0) return ''

  // 1. Pod 이름에서 해시값 제거
  const podBaseName = pod.name
    ?.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/i, '')
    .replace(/-[0-9]+$/i, '')

  // 2. Pod base 이름과 일치하는 컨테이너
  const byName = containers.find((c) => c.name === podBaseName)
  if (byName) return byName.name

  // 3. 사이드카 패턴 제외하고 첫 번째
  const nonSidecar = containers.find(
    (c) => !SIDECAR_PATTERNS.some((p) => c.name.includes(p)),
  )
  return nonSidecar?.name ?? containers[0].name
}

export type DetailTab = 'summary' | 'logs' | 'describe' | 'rbac' | 'manifest' | 'exec'

export function podToDetail(pod: any): PodDetail {
  return {
    name: pod.name,
    namespace: pod.namespace,
    node: pod.node_name || '',
    status: pod.status || '',
    phase: pod.phase || pod.status || '',
    restart_count: pod.restart_count || 0,
    created_at: pod.created_at || '',
    containers: pod.containers || [],
  }
}
