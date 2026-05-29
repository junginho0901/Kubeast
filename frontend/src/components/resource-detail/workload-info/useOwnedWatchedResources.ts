import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo, ReplicaSetInfo, PVCInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { applyPodWatchEvent } from '@/pages/workloads/pods/podWatchNormalize'
import { applyReplicaSetWatchEvent } from '@/pages/workloads/replicasets/replicaSetWatchNormalize'

interface Params {
  kind: string
  namespace?: string
  name: string
  selector?: Record<string, string>
  volumeClaimTemplates?: Array<any>
}

interface Result {
  pods: PodInfo[]
  replicaSets: ReplicaSetInfo[]
  pvcsByPodName: Map<string, Array<{ vct: string; pvc?: PVCInfo }>>
  podsEnabled: boolean
  rsEnabled: boolean
  pvcsEnabled: boolean
}

function selectorToString(selector?: Record<string, string>): string {
  if (!selector) return ''
  return Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')
}

// Provides live owned/matching child resources for Deployment / Job / DaemonSet /
// ReplicaSet / StatefulSet detail. Pods are listed via labelSelector for Deployment,
// via ownerReference filter for ReplicaSet/DaemonSet/StatefulSet/Job. Updates stream
// through useKubeWatchList so kubectl scale / delete reflects immediately.
export function useOwnedWatchedResources({ kind, namespace, name, selector, volumeClaimTemplates }: Params): Result {
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

  const vctNames = useMemo(
    () => (Array.isArray(volumeClaimTemplates)
      ? volumeClaimTemplates
        .map((v: any) => v?.metadata?.name ?? v?.name)
        .filter((n: any): n is string => typeof n === 'string' && n.length > 0)
      : []),
    [volumeClaimTemplates],
  )

  const pvcsEnabled = kind === 'StatefulSet' && !!namespace && vctNames.length > 0

  const { data: pvcs } = useQuery({
    queryKey: ['owned-watched-pvcs', namespace, name, vctNames.join('|')],
    queryFn: () => api.getPVCs(namespace),
    enabled: pvcsEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: pvcsEnabled,
    queryKey: ['owned-watched-pvcs', namespace, name, vctNames.join('|')],
    path: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`,
    query: 'watch=1',
  })

  const pvcsByPodName = useMemo(() => {
    const map = new Map<string, Array<{ vct: string; pvc?: PVCInfo }>>()
    if (!Array.isArray(pvcs) || vctNames.length === 0) return map
    const pvcByName = new Map<string, PVCInfo>()
    for (const pvc of pvcs as Array<PVCInfo | any>) {
      const pvcName = pvc?.name ?? pvc?.metadata?.name
      if (pvcName) pvcByName.set(pvcName, pvc as PVCInfo)
    }
    const ownedNames = (Array.isArray(pods) ? pods : []).map((p) => p.name)
    for (const podName of ownedNames) {
      const entries = vctNames.map((vctName) => ({
        vct: vctName,
        pvc: pvcByName.get(`${vctName}-${podName}`),
      }))
      map.set(podName, entries)
    }
    return map
  }, [pvcs, pods, vctNames])

  return {
    pods: Array.isArray(pods) ? pods : [],
    replicaSets: Array.isArray(replicaSets) ? replicaSets : [],
    pvcsByPodName,
    podsEnabled,
    rsEnabled,
    pvcsEnabled,
  }
}
