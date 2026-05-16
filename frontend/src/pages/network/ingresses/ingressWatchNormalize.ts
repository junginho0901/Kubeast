// Ingress watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/Ingresses.tsx 의 normalizeBackend /
// normalizeWatchIngressObject / applyIngressWatchEvent 추출. raw k8s Ingress
// object 를 API list 형태 (IngressInfo) 로 정규화 — spec.ingressClassName /
// annotation 모두 지원하여 class/class_source 결정 + rules/paths/backends 정규화.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { IngressInfo } from '@/services/api'

function normalizeBackend(backend: any): any {
  if (!backend || typeof backend !== 'object') return {}
  const service = backend?.service
  if (service) {
    const portObj = service?.port
    const port = portObj?.number ?? portObj?.name ?? null
    return {
      type: 'service',
      service: {
        name: service?.name ?? null,
        port,
      },
    }
  }
  const resource = backend?.resource
  if (resource) {
    return {
      type: 'resource',
      resource,
    }
  }
  return {}
}

export function normalizeWatchIngressObject(obj: any): IngressInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && Array.isArray(obj?.hosts)) {
    return {
      ...obj,
      backends: Array.isArray(obj?.backends) ? obj.backends : [],
      hosts: Array.isArray(obj?.hosts) ? obj.hosts : [],
      rules: Array.isArray(obj?.rules) ? obj.rules : [],
      tls: Array.isArray(obj?.tls) ? obj.tls : [],
      addresses: Array.isArray(obj?.addresses) ? obj.addresses : [],
      annotations: obj?.annotations || {},
      labels: obj?.labels || {},
    } as IngressInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const annotations = metadata?.annotations ?? {}
  const labels = metadata?.labels ?? {}
  const specClass = spec?.ingressClassName ?? null
  const annoClass = annotations?.['kubernetes.io/ingress.class'] ?? null
  const ingressClass = specClass || annoClass || null
  const classSource = specClass ? 'spec' : annoClass ? 'annotation' : null

  const addresses = (status?.loadBalancer?.ingress || []).map((item: any) => ({
    ip: item?.ip ?? null,
    hostname: item?.hostname ?? null,
  }))

  const tls = (spec?.tls || []).map((item: any) => ({
    secret_name: item?.secretName ?? null,
    hosts: Array.isArray(item?.hosts) ? item.hosts : [],
  }))

  const defaultBackend = normalizeBackend(spec?.defaultBackend)
  const backends = new Set<string>()
  if (defaultBackend?.type === 'service' && defaultBackend?.service?.name) {
    backends.add(defaultBackend.service.name)
  } else if (defaultBackend?.type === 'resource') {
    const kind = defaultBackend?.resource?.kind
    const name = defaultBackend?.resource?.name
    if (kind && name) backends.add(`${kind}:${name}`)
  }

  const rules = (spec?.rules || []).map((rule: any) => {
    const paths = (rule?.http?.paths || []).map((p: any) => {
      const backend = normalizeBackend(p?.backend)
      if (backend?.type === 'service' && backend?.service?.name) {
        backends.add(backend.service.name)
      } else if (backend?.type === 'resource') {
        const kind = backend?.resource?.kind
        const name = backend?.resource?.name
        if (kind && name) backends.add(`${kind}:${name}`)
      }
      return {
        path: p?.path ?? null,
        path_type: p?.pathType ?? null,
        backend,
      }
    })
    return {
      host: rule?.host ?? null,
      paths,
    }
  })

  const hosts = rules
    .map((r: any) => r?.host)
    .filter((v: any) => typeof v === 'string' && v.length > 0)

  return {
    name: metadata?.name ?? '',
    namespace: metadata?.namespace ?? '',
    hosts,
    class: ingressClass,
    class_source: classSource,
    backends: [...backends],
    addresses,
    tls,
    default_backend: defaultBackend,
    rules,
    labels,
    annotations,
    created_at: metadata?.creationTimestamp ?? null,
  }
}

export function applyIngressWatchEvent(prev: IngressInfo[] | undefined, event: { type?: string; object?: any }): IngressInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchIngressObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)

  return items
}
