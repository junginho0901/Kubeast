// Network 페이지의 분석 훅 (related/heuristics/policySummary/ingressDetails)
//
// frontend/src/pages/Network.tsx 의 4 useMemo + ingressDetails useQuery 를 묶어
// 한 hook 으로 추출. 입력 query 데이터들과 selectedService 만 받아 derived 상태 반환.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  api,
  type EndpointInfo,
  type EndpointSliceInfo,
  type IngressDetail,
  type IngressInfo,
  type NetworkPolicyInfo,
  type PodInfo,
  type ServiceInfo,
} from '@/services/api'
import { isNumeric, podMatchesNetworkPolicy } from './netHelpers'

export interface NetworkAnalysisInput {
  namespace: string | undefined
  selectedService: ServiceInfo | null
  endpoints: EndpointInfo[] | undefined
  endpointSlices: EndpointSliceInfo[] | undefined
  ingresses: IngressInfo[] | undefined
  networkPolicies: NetworkPolicyInfo[] | undefined
  podsForService: PodInfo[] | undefined | null
}

export interface RelatedResources {
  endpoints: EndpointInfo | null
  endpointSlices: EndpointSliceInfo[]
  ingresses: IngressInfo[]
  networkPolicies: NetworkPolicyInfo[]
}

export interface HeuristicWarning {
  level: 'error' | 'warn'
  title: string
  detail?: string
}

export interface PolicySummary {
  ingressIsolationOn: boolean
  egressIsolationOn: boolean
  ingressEffectiveDenyAll: boolean
  egressEffectiveDenyAll: boolean
  namespaceDefaultDenyIngress: boolean
  namespaceDefaultDenyEgress: boolean
}

export function useNetworkAnalysis({
  namespace,
  selectedService,
  endpoints,
  endpointSlices,
  ingresses,
  networkPolicies,
  podsForService,
}: NetworkAnalysisInput) {
  const related = useMemo<RelatedResources>(() => {
    if (!selectedService) {
      return {
        endpoints: null,
        endpointSlices: [],
        ingresses: [],
        networkPolicies: [],
      }
    }

    const endpoint = (endpoints ?? []).find((e) => e.name === selectedService.name) ?? null
    const slices = (endpointSlices ?? []).filter((s) => s.service_name === selectedService.name)
    const ingressList = (ingresses ?? []).filter((ing) => (ing.backends ?? []).includes(selectedService.name))

    const pods = podsForService ?? []
    const policies = (networkPolicies ?? []).filter((p) => {
      if (pods.length === 0) return false
      // Empty selector means "all pods"
      const sel = p.pod_selector
      const hasAnyConstraint =
        (sel?.match_labels && Object.keys(sel.match_labels).length > 0) ||
        (sel?.match_expressions && sel.match_expressions.length > 0)
      if (!hasAnyConstraint) return true
      return pods.some((pod) => podMatchesNetworkPolicy(pod, p))
    })

    return {
      endpoints: endpoint,
      endpointSlices: slices,
      ingresses: ingressList,
      networkPolicies: policies,
    }
  }, [selectedService, endpoints, endpointSlices, ingresses, networkPolicies, podsForService])

  const heuristics = useMemo<HeuristicWarning[]>(() => {
    if (!selectedService) return []

    const hasSelector = Object.keys(selectedService.selector || {}).length > 0
    // ExternalName has no endpoints by design
    if (selectedService.type === 'ExternalName') return []

    const endpoint = related.endpoints
    const endpointTotal = endpoint ? (endpoint.ready_count || 0) + (endpoint.not_ready_count || 0) : 0
    const endpointReady = endpoint ? (endpoint.ready_count || 0) : 0

    const slices = related.endpointSlices || []
    const sliceTotal = slices.reduce((sum, s) => sum + (s.endpoints_total || 0), 0)
    const sliceReady = slices.reduce((sum, s) => sum + (s.endpoints_ready || 0), 0)

    const warnings: HeuristicWarning[] = []

    // Selector exists but endpoints empty
    if (hasSelector && Array.isArray(podsForService) && podsForService.length > 0 && endpointTotal === 0) {
      warnings.push({
        level: 'error',
        title: 'Selector는 매칭되는데 Endpoints가 비어있습니다',
        detail: 'Pod Ready/ReadinessProbe, Service targetPort, 또는 selector/label 불일치를 확인하세요.',
      })
    } else if (hasSelector && endpointTotal === 0 && sliceTotal > 0) {
      warnings.push({
        level: 'warn',
        title: 'Endpoints는 비어있는데 EndpointSlices는 존재합니다',
        detail: `EndpointSlices total=${sliceTotal}`,
      })
    } else if (hasSelector && endpointTotal === 0) {
      warnings.push({
        level: 'warn',
        title: 'Selector는 있는데 Endpoints가 비어있습니다',
        detail: 'selector가 매칭되는 Pod가 없거나, 아직 Ready가 아닐 수 있습니다.',
      })
    }

    // Endpoints vs slices mismatch
    if (endpointTotal > 0 && sliceTotal > 0 && endpointTotal !== sliceTotal) {
      warnings.push({
        level: 'warn',
        title: 'Endpoints와 EndpointSlices의 개수가 다릅니다',
        detail: `Endpoints=${endpointTotal}, EndpointSlices total=${sliceTotal}`,
      })
    }
    if (endpointReady !== sliceReady && (endpointReady > 0 || sliceReady > 0)) {
      warnings.push({
        level: 'warn',
        title: 'Ready Endpoints와 Ready EndpointSlices가 다릅니다',
        detail: `Endpoints ready=${endpointReady}, EndpointSlices ready=${sliceReady}`,
      })
    }

    // Service port name vs Endpoints port name mismatch (best-effort)
    if (endpoint && Array.isArray((endpoint as any).ports) && (endpoint as any).ports.length > 0) {
      const endpointPorts = (endpoint as any).ports as Array<any>
      for (const sp of selectedService.ports || []) {
        const svcPortName = (sp as any).name as string | undefined
        if (svcPortName) {
          const ok = endpointPorts.some((ep) => ep?.name === svcPortName)
          if (!ok) {
            warnings.push({
              level: 'warn',
              title: `Service port name(${svcPortName})가 Endpoints port에 없습니다`,
              detail: 'port name/targetPort 불일치 가능성이 있습니다.',
            })
          }
        }
      }
    }

    // targetPort mismatch vs pod container ports (best-effort)
    if (hasSelector && Array.isArray(podsForService) && podsForService.length > 0) {
      const containerPortNumbers = new Set<number>()
      const containerPortNames = new Set<string>()

      for (const pod of podsForService) {
        for (const c of pod.containers || []) {
          const ports = (c as any).ports
          if (!Array.isArray(ports)) continue
          for (const p of ports) {
            if (typeof p?.container_port === 'number') containerPortNumbers.add(p.container_port)
            if (typeof p?.name === 'string' && p.name) containerPortNames.add(p.name)
          }
        }
      }

      const slicePortNumbers = new Set<number>()
      const slicePortNames = new Set<string>()
      for (const s of slices) {
        const ports = (s as any).ports
        if (!Array.isArray(ports)) continue
        for (const p of ports) {
          const port = p?.port
          const name = p?.name
          if (typeof port === 'number') slicePortNumbers.add(port)
          if (typeof name === 'string' && name) slicePortNames.add(name)
        }
      }

      const canValidateAgainstContainerPorts = containerPortNumbers.size > 0 || containerPortNames.size > 0

      for (const sp of selectedService.ports || []) {
        const targetPortRaw = (sp as any).target_port as string | undefined
        if (!targetPortRaw) continue

        if (isNumeric(targetPortRaw)) {
          const num = Number(targetPortRaw)
          // If containerPort is declared, validate against it (strong signal).
          // EndpointSlice ports can mirror Service spec, so they don't guarantee the container listens.
          if (Number.isFinite(num) && canValidateAgainstContainerPorts && !containerPortNumbers.has(num)) {
            const declared = containerPortNumbers.size > 0 ? `declared containerPorts: ${Array.from(containerPortNumbers).sort((a, b) => a - b).join(', ')}` : ''
            warnings.push({
              level: 'warn',
              title: `targetPort(${targetPortRaw})가 Pod containerPort에 없습니다`,
              detail: `Service가 실제 컨테이너 포트로 라우팅되지 않을 수 있습니다.${declared ? ` (${declared})` : ''}`,
            })
            continue
          }
          // If we can't validate via containerPort declarations, avoid noisy warnings when EndpointSlice already exists for that port.
          if (Number.isFinite(num) && !canValidateAgainstContainerPorts && slicePortNumbers.has(num)) continue
        } else {
          if (canValidateAgainstContainerPorts && !containerPortNames.has(targetPortRaw)) {
            const declared = containerPortNames.size > 0 ? `declared port names: ${Array.from(containerPortNames).sort().join(', ')}` : ''
            warnings.push({
              level: 'warn',
              title: `targetPort name(${targetPortRaw})가 Pod port name에 없습니다`,
              detail: `Service가 named port로 라우팅되지 않을 수 있습니다.${declared ? ` (${declared})` : ''}`,
            })
            continue
          }
          if (!canValidateAgainstContainerPorts && slicePortNames.has(targetPortRaw)) continue
        }
      }
    }

    return warnings
  }, [podsForService, related.endpoints, related.endpointSlices, selectedService])

  const policySummary = useMemo<PolicySummary>(() => {
    const policies = related.networkPolicies || []
    const ingressIsolationOn = policies.some((p) => (p.policy_types || []).includes('Ingress'))
    const egressIsolationOn = policies.some((p) => (p.policy_types || []).includes('Egress'))
    const totalIngressRules = policies.reduce((sum, p) => sum + (p.ingress_rules || 0), 0)
    const totalEgressRules = policies.reduce((sum, p) => sum + (p.egress_rules || 0), 0)
    const ingressEffectiveDenyAll = ingressIsolationOn && totalIngressRules === 0
    const egressEffectiveDenyAll = egressIsolationOn && totalEgressRules === 0
    const namespaceDefaultDenyIngress = policies.some((p) => p.selects_all_pods && p.default_deny_ingress)
    const namespaceDefaultDenyEgress = policies.some((p) => p.selects_all_pods && p.default_deny_egress)

    return {
      ingressIsolationOn,
      egressIsolationOn,
      ingressEffectiveDenyAll,
      egressEffectiveDenyAll,
      namespaceDefaultDenyIngress,
      namespaceDefaultDenyEgress,
    }
  }, [related.networkPolicies])

  const ingressDetailNames = useMemo(() => {
    const list = related.ingresses || []
    return list.map((i) => i.name).sort()
  }, [related.ingresses])

  const { data: ingressDetails } = useQuery({
    queryKey: ['network', 'ingressDetails', namespace, ingressDetailNames.join(',')],
    queryFn: async () => {
      if (!namespace) return []
      if (ingressDetailNames.length === 0) return []
      const results = await Promise.all(ingressDetailNames.map((n) => api.getIngressDetail(namespace, n)))
      return results as IngressDetail[]
    },
    enabled: !!namespace && ingressDetailNames.length > 0,
  })

  return { related, heuristics, policySummary, ingressDetails }
}
