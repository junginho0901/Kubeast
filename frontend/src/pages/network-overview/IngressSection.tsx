// Service detail panel 의 Ingress 섹션 (이름/class/address/tls/rules/events)
//
// frontend/src/pages/Network.tsx 의 Ingress card 추출. ingressDetails (per-ingress
// detail useQuery 결과) 와 ingressClasses (cluster-scope) 를 결합해 표시.

import type { IngressClassInfo, IngressDetail, IngressInfo } from '@/services/api'

interface Props {
  ingresses: IngressInfo[]
  ingressDetails: IngressDetail[] | undefined
  ingressClasses: IngressClassInfo[] | undefined
}

export function IngressSection({ ingresses, ingressDetails, ingressClasses }: Props) {
  return (
    <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
      <div className="text-sm font-semibold text-white mb-2">Ingress</div>
      {ingresses.length === 0 ? (
        <div className="text-sm text-slate-400">(없음)</div>
      ) : (
        <div className="space-y-3">
          {ingresses.map((ing) => {
            const detail = (ingressDetails ?? []).find((d) => d.name === ing.name) ?? null
            const klass =
              (ingressClasses ?? []).find((c) => c.name === (detail?.class ?? ing.class ?? '')) ?? null
            const addresses = (detail?.addresses || [])
              .map((a) => a.ip || a.hostname)
              .filter(Boolean)
              .join(', ')
            const tlsSecrets = (detail?.tls || [])
              .map((t) => t.secret_name)
              .filter(Boolean)
              .join(', ')
            const classSourceLabel =
              detail?.class_source === 'spec'
                ? 'spec'
                : detail?.class_source === 'annotation'
                  ? 'annotation'
                  : detail?.class_source === 'default'
                    ? 'default candidate'
                    : null
            return (
              <div key={ing.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-slate-100 truncate">{ing.name}</div>
                  <div className="text-xs text-slate-400">
                    class: {detail?.class || ing.class || '(none)'}
                    {classSourceLabel ? ` (${classSourceLabel})` : ''}
                    {detail?.class_is_default || klass?.is_default ? ' (default)' : ''}
                  </div>
                </div>
                {addresses ? (
                  <div className="mt-2 text-[11px] text-slate-400">address: {addresses}</div>
                ) : (
                  <div className="mt-2 text-[11px] text-slate-500">address: (없음)</div>
                )}
                {tlsSecrets ? (
                  <div className="mt-1 text-[11px] text-slate-400">tls secret: {tlsSecrets}</div>
                ) : (
                  <div className="mt-1 text-[11px] text-slate-500">tls secret: (없음)</div>
                )}
                <div className="mt-2 text-xs text-slate-300 whitespace-pre-wrap break-words">
                  {(detail?.rules || []).length > 0
                    ? detail!.rules
                        .flatMap((r) =>
                          (r.paths || []).map((p) => {
                            const host = r.host || '*'
                            const path = p.path || '/'
                            const pathType = p.path_type ? ` (${p.path_type})` : ''
                            const backend = (p.backend && p.backend.service && p.backend.service.name)
                              ? ` → ${p.backend.service.name}:${p.backend.service.port ?? ''}`
                              : ''
                            return `${host} ${path}${pathType}${backend}`
                          })
                        )
                        .join('\n') || '(rules 없음)'
                    : (ing.hosts || []).join('\n') || '(hosts 없음)'}
                </div>
                <div className="mt-2 text-[11px] text-slate-400">
                  controller: {detail?.class_controller || klass?.controller || '(unknown)'}
                </div>
                {(detail?.events || []).length > 0 ? (
                  <div className="mt-2 border-t border-slate-700 pt-2">
                    <div className="text-[11px] text-slate-400 mb-1">events (latest)</div>
                    <div className="space-y-1">
                      {detail!.events.slice(0, 3).map((e, idx) => (
                        <div key={idx} className="text-[11px] text-slate-300">
                          [{e.type || ''}] {e.reason || ''}: {e.message || ''}{' '}
                          {e.count ? `(x${e.count})` : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
