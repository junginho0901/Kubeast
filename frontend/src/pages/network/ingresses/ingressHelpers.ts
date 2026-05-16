// Ingresses 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/Ingresses.tsx 의 parseAgeSeconds / formatAge /
// formatHosts / formatBackends / formatAddresses / formatRules /
// ingressToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { IngressInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'class' | 'hosts' | 'backends' | 'addresses' | 'age'

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatHosts(ing: IngressInfo): string {
  if (!Array.isArray(ing.hosts) || ing.hosts.length === 0) return '-'
  return ing.hosts.join(', ')
}

export function formatBackends(ing: IngressInfo): string {
  if (!Array.isArray(ing.backends) || ing.backends.length === 0) return '-'
  return ing.backends.join(', ')
}

export function formatAddresses(ing: IngressInfo): string {
  const addresses = Array.isArray(ing.addresses) ? ing.addresses : []
  if (addresses.length === 0) return '-'
  return addresses
    .map((a) => a?.ip || a?.hostname || '-')
    .filter(Boolean)
    .join(', ')
}

export function formatRules(ing: IngressInfo): string {
  const rules = Array.isArray(ing.rules) ? ing.rules : []
  if (rules.length === 0) return '-'

  const items: string[] = []
  for (const rule of rules) {
    const host = rule?.host || '*'
    const paths = Array.isArray(rule?.paths) ? rule.paths : []
    if (paths.length === 0) {
      items.push(`${host}:/*`)
      continue
    }
    for (const p of paths) {
      const path = p?.path || '/'
      items.push(`${host}:${path}`)
    }
  }
  if (items.length === 0) return '-'
  if (items.length <= 2) return items.join(', ')
  return `${items.slice(0, 2).join(', ')} +${items.length - 2}`
}

export function ingressToRawJson(ing: IngressInfo): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ing.name,
      namespace: ing.namespace,
      labels: ing.labels || {},
      annotations: ing.annotations || {},
      creationTimestamp: ing.created_at,
    },
    spec: {
      ingressClassName: ing.class || undefined,
      defaultBackend: ing.default_backend || undefined,
      tls: (ing.tls || []).map((t) => ({
        secretName: t.secret_name,
        hosts: t.hosts || [],
      })),
      rules: (ing.rules || []).map((rule) => ({
        host: rule.host || undefined,
        http: {
          paths: (rule.paths || []).map((p) => ({
            path: p.path || undefined,
            pathType: p.path_type || undefined,
            backend: p.backend || undefined,
          })),
        },
      })),
    },
    status: {
      loadBalancer: {
        ingress: (ing.addresses || []).map((a) => ({
          ip: a?.ip,
          hostname: a?.hostname,
        })),
      },
    },
    class_source: ing.class_source,
    class_controller: ing.class_controller,
    class_is_default: ing.class_is_default,
  }
}
