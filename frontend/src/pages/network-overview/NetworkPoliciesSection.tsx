// Service detail panel 의 NetworkPolicies (적용 후보) 섹션
//
// frontend/src/pages/Network.tsx 의 NetworkPolicy card 추출. policySummary 를
// 상단 badge 로 표시 + per-policy detail (ingress/egress allow rules 일부) 표시.

import { Shield } from 'lucide-react'
import type { NetworkPolicyInfo, PodInfo } from '@/services/api'
import { formatPeer, formatPorts, selectorToInline } from './netHelpers'
import type { PolicySummary } from './useNetworkAnalysis'

interface Props {
  labelSelector: string | undefined
  podsForService: PodInfo[] | undefined | null
  networkPolicies: NetworkPolicyInfo[]
  policySummary: PolicySummary
}

export function NetworkPoliciesSection({ labelSelector, podsForService, networkPolicies, policySummary }: Props) {
  return (
    <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
      <div className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        NetworkPolicies (적용 후보)
      </div>
      {!labelSelector ? (
        <div className="text-sm text-slate-400">selector가 없어 Pod 매핑을 못해 정책 연결을 계산할 수 없습니다</div>
      ) : (podsForService ?? []).length === 0 ? (
        <div className="text-sm text-slate-400">선택된 Service selector에 매칭되는 Pod가 없습니다</div>
      ) : networkPolicies.length === 0 ? (
        <div className="text-sm text-slate-400">(없음)</div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-slate-700 bg-slate-900/20 p-3 text-xs text-slate-300">
            <div className="flex flex-wrap gap-2">
              <span className={`badge ${policySummary.ingressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                Ingress isolation: {policySummary.ingressIsolationOn ? 'ON' : 'OFF'}
              </span>
              <span className={`badge ${policySummary.egressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                Egress isolation: {policySummary.egressIsolationOn ? 'ON' : 'OFF'}
              </span>
              {policySummary.ingressEffectiveDenyAll ? (
                <span className="badge badge-error">Ingress: deny-all</span>
              ) : null}
              {policySummary.egressEffectiveDenyAll ? (
                <span className="badge badge-error">Egress: deny-all</span>
              ) : null}
              {policySummary.namespaceDefaultDenyIngress ? (
                <span className="badge badge-info">ns default-deny ingress policy present</span>
              ) : null}
              {policySummary.namespaceDefaultDenyEgress ? (
                <span className="badge badge-info">ns default-deny egress policy present</span>
              ) : null}
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              ON이면 “허용 규칙의 합(Union)”만 통과합니다. (CNI/클러스터 설정에 따라 실제 동작은 달라질 수 있음)
            </div>
          </div>

          {networkPolicies.map((p) => (
            <div key={p.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-slate-100 truncate">{p.name}</div>
                <div className="text-xs text-slate-400">{(p.policy_types || []).join(', ') || ''}</div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {p.default_deny_ingress ? <span className="badge badge-error">default-deny ingress</span> : null}
                {p.default_deny_egress ? <span className="badge badge-error">default-deny egress</span> : null}
                {p.selects_all_pods ? <span className="badge badge-info">selects all pods</span> : null}
              </div>
              <div className="mt-1 text-xs text-slate-300">
                ingress rules: {p.ingress_rules} · egress rules: {p.egress_rules}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                selector:{' '}
                {selectorToInline(p.pod_selector as any, 'all pods')}
              </div>

              {(p.ingress && p.ingress.length > 0) || p.default_deny_ingress ? (
                <div className="mt-3">
                  <div className="text-[11px] text-slate-400 mb-1">Ingress allow</div>
                  {p.ingress && p.ingress.length > 0 ? (
                    <div className="space-y-2">
                      {p.ingress.slice(0, 2).map((r, idx) => {
                        const peers = Array.isArray(r.from) ? r.from : []
                        const from = peers.length === 0 ? '(all sources)' : peers.slice(0, 2).map(formatPeer).join(' | ')
                        const ports = formatPorts(r.ports)
                        return (
                          <div key={idx} className="text-[11px] text-slate-300">
                            {from} · {ports}
                          </div>
                        )
                      })}
                      {p.ingress.length > 2 ? (
                        <div className="text-[11px] text-slate-500">… +{p.ingress.length - 2} more ingress rules</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">(no ingress rules)</div>
                  )}
                </div>
              ) : null}

              {(p.egress && p.egress.length > 0) || p.default_deny_egress ? (
                <div className="mt-3">
                  <div className="text-[11px] text-slate-400 mb-1">Egress allow</div>
                  {p.egress && p.egress.length > 0 ? (
                    <div className="space-y-2">
                      {p.egress.slice(0, 2).map((r, idx) => {
                        const peers = Array.isArray(r.to) ? r.to : []
                        const to = peers.length === 0 ? '(all destinations)' : peers.slice(0, 2).map(formatPeer).join(' | ')
                        const ports = formatPorts(r.ports)
                        return (
                          <div key={idx} className="text-[11px] text-slate-300">
                            {to} · {ports}
                          </div>
                        )
                      })}
                      {p.egress.length > 2 ? (
                        <div className="text-[11px] text-slate-500">… +{p.egress.length - 2} more egress rules</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">(no egress rules)</div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
