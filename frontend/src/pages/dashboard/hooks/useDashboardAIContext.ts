import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'

// Floating AI assistant 의 "현재 화면 컨텍스트" snapshot 을 빌드하고
// useAIContext 로 등록하는 hook. Dashboard.tsx 의 80줄 inline useMemo +
// useAIContext call 을 분리.
//
// 반환값 없음 — useAIContext 의 부수효과 (전역 컨텍스트 register) 가 목적.

interface Params {
  overview: any
  nodes: any
  topResources: any
  allPods: any
}

export function useDashboardAIContext({ overview, nodes, topResources, allPods }: Params): void {
  const aiSnapshot = useMemo(() => {
    if (!overview) return null
    const podStatus = overview.pod_status || {}
    const running = podStatus['Running'] ?? 0
    const total = overview.total_pods ?? 0
    const unhealthy = total - running
    const prefix = unhealthy > 0 ? '⚠️ ' : ''
    const nodeLabel = typeof overview.node_count === 'number'
      ? `노드 ${overview.node_count}개`
      : '노드 정보 없음'
    const summary = `${prefix}클러스터 — ${nodeLabel}, Pod ${running}/${total} Running${unhealthy > 0 ? `, 문제 ${unhealthy}` : ''}`

    const interpretations: string[] = []
    for (const [phase, count] of Object.entries(podStatus)) {
      if (phase !== 'Running' && phase !== 'Succeeded' && (count as number) > 0) {
        interpretations.push(`⚠️ Pod ${count}개가 ${phase} 상태`)
      }
    }

    return {
      source: 'base' as const,
      summary,
      data: {
        cluster: {
          version: overview.cluster_version,
          node_count: overview.node_count,
          total_namespaces: overview.total_namespaces,
          total_pods: overview.total_pods,
          total_services: overview.total_services,
          total_deployments: overview.total_deployments,
          total_pvcs: overview.total_pvcs,
          total_pvs: overview.total_pvs,
        },
        pod_status: podStatus,
        nodes: Array.isArray(nodes)
          ? (nodes as Array<{ name: string; status: string }>).slice(0, 10).map((n) => ({
              name: n.name,
              status: n.status,
            }))
          : undefined,
        // 화면 우측 위젯: Top 5 Pods / Top 3 Nodes (CPU·Memory 사용량 상위)
        top_pods: Array.isArray(topResources?.top_pods)
          ? topResources!.top_pods.slice(0, 5).map((p: any) => ({
              name: p.name,
              namespace: p.namespace,
              cpu: p.cpu,
              memory: p.memory,
              cpu_percent: p.cpu_percent,
              memory_percent: p.memory_percent,
            }))
          : undefined,
        top_nodes: Array.isArray(topResources?.top_nodes)
          ? topResources!.top_nodes.slice(0, 3).map((n: any) => ({
              name: n.name,
              cpu: n.cpu,
              memory: n.memory,
              cpu_percent: n.cpu_percent,
              memory_percent: n.memory_percent,
            }))
          : undefined,
        // 문제 있는 Pod 의 이름·이유 — allPods 가 fetch 된 상태에서만 (lazy)
        failed_pods: Array.isArray(allPods)
          ? (allPods as Array<{ name: string; namespace: string; phase?: string; status?: string; restart_count?: number }>)
              .filter((p) => {
                const ph = p.phase || p.status || ''
                return ph !== 'Running' && ph !== 'Succeeded'
              })
              .slice(0, 10)
              .map((p) => ({
                name: p.name,
                namespace: p.namespace,
                phase: p.phase,
                status: p.status,
                restart_count: p.restart_count,
              }))
          : undefined,
        ...(interpretations.length > 0 ? { interpretations } : {}),
      },
    }
  }, [overview, nodes, topResources, allPods])

  useAIContext(aiSnapshot, [aiSnapshot])
}
