// Service detail panel 의 NetworkPolicies (적용 후보) 섹션
//
// frontend/src/pages/Network.tsx 의 NetworkPolicy card 추출. policySummary 를
// 상단 badge 로 표시 + per-policy detail (ingress/egress allow rules 일부) 표시.

import { Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  return (
    <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
      <div className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        {t('networkOverview.networkPoliciesTitle')}
      </div>
      {!labelSelector ? (
        <div className="text-sm text-slate-400">{t('networkOverview.noSelector')}</div>
      ) : (podsForService ?? []).length === 0 ? (
        <div className="text-sm text-slate-400">{t('networkOverview.noMatchingPods')}</div>
      ) : networkPolicies.length === 0 ? (
        <div className="text-sm text-slate-400">{t('networkOverview.none')}</div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-slate-700 bg-slate-900/20 p-3 text-xs text-slate-300">
            <div className="flex flex-wrap gap-2">
              <span className={`badge ${policySummary.ingressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                {t('networkOverview.ingressIsolation', 'Ingress isolation')}: {policySummary.ingressIsolationOn ? t('networkOverview.on', 'ON') : t('networkOverview.off', 'OFF')}
              </span>
              <span className={`badge ${policySummary.egressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                {t('networkOverview.egressIsolation', 'Egress isolation')}: {policySummary.egressIsolationOn ? t('networkOverview.on', 'ON') : t('networkOverview.off', 'OFF')}
              </span>
              {policySummary.ingressEffectiveDenyAll ? (
                <span className="badge badge-error">Ingress: deny-all</span>
              ) : null}
              {policySummary.egressEffectiveDenyAll ? (
                <span className="badge badge-error">Egress: deny-all</span>
              ) : null}
              {policySummary.namespaceDefaultDenyIngress ? (
                <span className="badge badge-info">{t('networkOverview.nsDefaultDenyIngress', 'ns default-deny ingress policy present')}</span>
              ) : null}
              {policySummary.namespaceDefaultDenyEgress ? (
                <span className="badge badge-info">{t('networkOverview.nsDefaultDenyEgress', 'ns default-deny egress policy present')}</span>
              ) : null}
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              {t('networkOverview.isolationHint')}
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
                {p.selects_all_pods ? <span className="badge badge-info">{t('networkOverview.selectsAllPods', 'selects all pods')}</span> : null}
              </div>
              <div className="mt-1 text-xs text-slate-300">
                {t('networkOverview.ruleCounts', { defaultValue: 'ingress rules: {{ingress}} · egress rules: {{egress}}', ingress: p.ingress_rules, egress: p.egress_rules })}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                selector:{' '}
                {selectorToInline(p.pod_selector as any, t('networkOverview.allPods', 'all pods'))}
              </div>

              {(p.ingress && p.ingress.length > 0) || p.default_deny_ingress ? (
                <div className="mt-3">
                  <div className="text-[11px] text-slate-400 mb-1">{t('networkOverview.ingressAllow', 'Ingress allow')}</div>
                  {p.ingress && p.ingress.length > 0 ? (
                    <div className="space-y-2">
                      {p.ingress.slice(0, 2).map((r, idx) => {
                        const peers = Array.isArray(r.from) ? r.from : []
                        const from = peers.length === 0 ? t('networkOverview.allSources', '(all sources)') : peers.slice(0, 2).map(formatPeer).join(' | ')
                        const ports = formatPorts(r.ports)
                        return (
                          <div key={idx} className="text-[11px] text-slate-300">
                            {from} · {ports}
                          </div>
                        )
                      })}
                      {p.ingress.length > 2 ? (
                        <div className="text-[11px] text-slate-500">… {t('networkOverview.moreIngressRules', { defaultValue: '+{{n}} more ingress rules', n: p.ingress.length - 2 })}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">{t('networkOverview.noIngressRules', '(no ingress rules)')}</div>
                  )}
                </div>
              ) : null}

              {(p.egress && p.egress.length > 0) || p.default_deny_egress ? (
                <div className="mt-3">
                  <div className="text-[11px] text-slate-400 mb-1">{t('networkOverview.egressAllow', 'Egress allow')}</div>
                  {p.egress && p.egress.length > 0 ? (
                    <div className="space-y-2">
                      {p.egress.slice(0, 2).map((r, idx) => {
                        const peers = Array.isArray(r.to) ? r.to : []
                        const to = peers.length === 0 ? t('networkOverview.allDestinations', '(all destinations)') : peers.slice(0, 2).map(formatPeer).join(' | ')
                        const ports = formatPorts(r.ports)
                        return (
                          <div key={idx} className="text-[11px] text-slate-300">
                            {to} · {ports}
                          </div>
                        )
                      })}
                      {p.egress.length > 2 ? (
                        <div className="text-[11px] text-slate-500">… {t('networkOverview.moreEgressRules', { defaultValue: '+{{n}} more egress rules', n: p.egress.length - 2 })}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">{t('networkOverview.noEgressRules', '(no egress rules)')}</div>
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
