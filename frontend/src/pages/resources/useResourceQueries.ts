// Resources 페이지의 8개 useQuery 묶음. Resources.tsx 에서 추출 (Phase 3.5.b).
//
// 각 탭이 활성화될 때만 (`enabled: activeTab === 'xxx'`) fetch — Resources
// 페이지가 단일 namespace 안에서 7가지 리소스 종류를 보여주는 구조라 탭 전환
// 시에만 필요한 데이터를 lazy fetch.
//
// 분리해도 동작 변화 없음 — 모든 useQuery 가 prop 으로 받은 namespace +
// activeTab + podLabelSelector 만 의존.

import { useQuery } from '@tanstack/react-query'

import { api } from '@/services/api'

import type { ResourceType } from './types'

interface Args {
  namespace: string | undefined
  activeTab: ResourceType
  podLabelSelector: string
}

export function useResourceQueries({ namespace, activeTab, podLabelSelector }: Args) {
  const { data: services } = useQuery({
    queryKey: ['services', namespace],
    queryFn: () => api.getServices(namespace!),
    enabled: !!namespace && activeTab === 'services',
  })

  const { data: deployments } = useQuery({
    queryKey: ['deployments', namespace],
    queryFn: () => api.getDeployments(namespace!),
    enabled: !!namespace && activeTab === 'deployments',
  })

  const { data: replicasets, error: replicasetsError } = useQuery({
    queryKey: ['replicasets', namespace],
    queryFn: () => api.getReplicaSets(namespace!, false),
    enabled: !!namespace && activeTab === 'replicasets',
    retry: 0,
  })

  const { data: hpas, error: hpasError } = useQuery({
    queryKey: ['hpas', namespace],
    queryFn: () => api.getHPAs(namespace!, false),
    enabled: !!namespace && activeTab === 'hpas',
    retry: 0,
  })

  const { data: pdbs, error: pdbsError } = useQuery({
    queryKey: ['pdbs', namespace],
    queryFn: () => api.getPDBs(namespace!, false),
    enabled: !!namespace && activeTab === 'pdbs',
    retry: 0,
  })

  const { data: podsForPdbs } = useQuery({
    queryKey: ['pods', namespace, '__for_pdbs__'],
    queryFn: () => api.getPods(namespace!, undefined, false),
    enabled: !!namespace && activeTab === 'pdbs',
  })

  const { data: pods } = useQuery({
    queryKey: ['pods', namespace, podLabelSelector || ''],
    queryFn: () => api.getPods(namespace!, podLabelSelector || undefined, false),
    enabled: !!namespace && activeTab === 'pods',
  })

  const { data: pvcs } = useQuery({
    queryKey: ['pvcs', namespace],
    queryFn: () => api.getPVCs(namespace),
    enabled: activeTab === 'pvcs',
  })

  return {
    services,
    deployments,
    replicasets,
    replicasetsError,
    hpas,
    hpasError,
    pdbs,
    pdbsError,
    podsForPdbs,
    pods,
    pvcs,
  }
}
