// IngressClasses 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/IngressClasses.tsx 의 parseAgeSeconds / formatAge /
// formatParameters / ingressClassToRawJson + SortKey 타입 추출.
// 순수 함수 + 타입 정의. IngressClass 는 cluster-scoped (namespace 없음).

import type { IngressClassInfo } from '@/services/api'

export type SortKey = null | 'name' | 'controller' | 'default' | 'parameters' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function formatParameters(item: IngressClassInfo): string {
  const p = item.parameters
  if (!p) return '-'
  const parts: string[] = []
  if (p.kind) parts.push(p.kind)
  if (p.api_group) parts.push(`.${p.api_group}`)
  if (p.name) parts.push(`/${p.name}`)
  if (p.scope) parts.push(` (${p.scope})`)
  if (p.namespace) parts.push(` ns=${p.namespace}`)
  const text = parts.join('')
  return text || '-'
}

export function ingressClassToRawJson(item: IngressClassInfo): Record<string, unknown> {
  const isDefault = Boolean(item.is_default)
  const annotations = { ...(item.annotations || {}) }
  if (isDefault && !annotations['ingressclass.kubernetes.io/is-default-class']) {
    annotations['ingressclass.kubernetes.io/is-default-class'] = 'true'
  }

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IngressClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      annotations,
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      controller: item.controller,
      parameters: item.parameters
        ? {
            apiGroup: item.parameters.api_group,
            kind: item.parameters.kind,
            name: item.parameters.name,
            scope: item.parameters.scope,
            namespace: item.parameters.namespace,
          }
        : undefined,
    },
    is_default: item.is_default,
    parameters: item.parameters,
  }
}
