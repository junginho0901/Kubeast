import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo, ReplicaSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { applyPodWatchEvent } from '@/pages/workloads/pods/podWatchNormalize'
import { applyReplicaSetWatchEvent } from '@/pages/workloads/replicasets/replicaSetWatchNormalize'

interface Params {
  kind: string
  namespace?: string
  name: string
  selector?: Record<string, string>
}

interface Result {
  pods: PodInfo[]
  replicaSets: ReplicaSetInfo[]
  podsEnabled: boolean
  rsEnabled: boolean
}

function selectorToString(selector?: Record<string, string>): string {
  if (!selector) return ''
  return Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')
}

// Provides live owned/matching child resources for Deployment / Job / DaemonSet /
// ReplicaSet / StatefulSet detail. Pods are listed via labelSelector for Deployment,
// via ownerReference filter for ReplicaSet/DaemonSet/StatefulSet/Job. Updates stream
// through useKubeWatchList so kubectl scale / delete reflects immediately.
export function useOwnedWatchedResources({ kind, namespace, name, selector }: Params): Result {
  const selectorStr = useMemo(() => selectorToString(selector), [selector])

  const podsKind = kind === 'DaemonSet' || kind === 'ReplicaSet' || kind === 'StatefulSet' || kind === 'Job' || kind === 'Deployment'
  const podsEnabled = podsKind && !!namespace && !!selectorStr
  const rsEnabled = kind === 'Deployment' && !!namespace && !!selectorStr

  const { data: pods } = useQuery({
    queryKey: ['owned-watched-pods', kind, namespace, name, selectorStr],
    queryFn: async () => {
      const all = await api.getPods(namespace as string, selectorStr)
      if (kind === 'Deployment') return all
      return all.filter((p: any) => {
        const refs = p?.owner_references || p?.metadata?.ownerReferences || []
        if (Array.isArray(refs) && refs.length > 0) {
          return refs.some((r: any) => r?.name === name)
        }
        return true
      })
    },
    enabled: podsEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: podsEnabled,
    queryKey: ['owned-watched-pods', kind, namespace, name, selectorStr],
    path: `/api/v1/namespaces/${namespace}/pods`,
    query: `watch=1&labelSelector=${encodeURIComponent(selectorStr)}`,
    applyEvent: (prev, event) => {
      const next = applyPodWatchEvent(prev as PodInfo[] | undefined, event)
      if (kind === 'Deployment') return next
      return next.filter((p: any) => {
        const refs = p?.owner_references || []
        if (Array.isArray(refs) && refs.length > 0) {
          return refs.some((r: any) => r?.name === name)
        }
        return true
      })
    },
  })

  const { data: replicaSets } = useQuery({
    queryKey: ['owned-watched-rs', namespace, name, selectorStr],
    queryFn: async () => {
      const all = await api.getReplicaSets(namespace as string)
      return all.filter((rs: any) => {
        const refs = rs?.owner_references || rs?.metadata?.ownerReferences || []
        return Array.isArray(refs) && refs.some((r: any) => r?.name === name && r?.kind === 'Deployment')
      })
    },
    enabled: rsEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: rsEnabled,
    queryKey: ['owned-watched-rs', namespace, name, selectorStr],
    path: `/apis/apps/v1/namespaces/${namespace}/replicasets`,
    query: `watch=1&labelSelector=${encodeURIComponent(selectorStr)}`,
    applyEvent: (prev, event) => {
      const next = applyReplicaSetWatchEvent(prev as ReplicaSetInfo[] | undefined, event)
      return next.filter((rs: any) => {
        const refs = rs?.owner_references || []
        return Array.isArray(refs) && refs.some((r: any) => r?.name === name && r?.kind === 'Deployment')
      })
    },
  })

  return {
    pods: Array.isArray(pods) ? pods : [],
    replicaSets: Array.isArray(replicaSets) ? replicaSets : [],
    podsEnabled,
    rsEnabled,
  }
}
