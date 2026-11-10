import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo, ReplicaSetInfo, PVCInfo, JobInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { applyReplicaSetWatchEvent } from '@/pages/workloads/replicasets/replicaSetWatchNormalize'
import { applyJobWatchEvent } from '@/pages/workloads/jobs/jobWatchNormalize'
import { useNamespacePodTable, type PodTableRow } from '../useNamespacePodTable'
import { SET_POD_TABLE_WATCH_MAX } from '../namespacePodTable'
import { selectorText } from '../netpolText'

interface Params {
  kind: string
  namespace?: string
  name: string
  // the selector's matchLabels (undefined while its answer is on its way) and matchExpressions
  selector?: Record<string, string>
  selectorExpressions?: { key: string; operator: string; values?: string[] }[]
  volumeClaimTemplates?: Array<any>
}

export interface OwnedResources {
  // every pod of the set, or the page shown when the table reads the server's pages (counted then says how many)
  pods: PodTableRow[]
  counted?: { total: number; notRunning?: number }
  podTable: ReturnType<typeof useNamespacePodTable>
  replicaSets: ReplicaSetInfo[]
  jobs: JobInfo[]
  pvcsByPodName: Map<string, Array<{ vct: string; pvc?: PVCInfo }>>
  podsEnabled: boolean
  podsLoaded: boolean
  rsEnabled: boolean
  jobsEnabled: boolean
  pvcsEnabled: boolean
}

// The pod's controller, else its first owner: the owner a server pod row keeps (pod_index.go), so the whole read and the
// server's pages list the same pods.
export function podOwnedBy(pod: PodInfo, kind: string, name: string): boolean {
  const refs = Array.isArray(pod?.owner_references) ? pod.owner_references : []
  const owner = refs.find((r) => r?.controller) ?? refs[0]
  return !!owner && owner.kind === kind && owner.name === name
}

// Provides live owned/matching child resources for Deployment / Job / DaemonSet /
// ReplicaSet / StatefulSet detail. Pods are the label selector's for a Deployment and,
// for the others, the ones they control; read as the drawers' namespace tables are
// (useNamespacePodTable): whole and live while few, else the server's pages.
export function useOwnedWatchedResources({ kind, namespace, name, selector, selectorExpressions, volumeClaimTemplates }: Params): OwnedResources {
  // the whole selector, as the controller selects (the same text as a PDB's and a NetworkPolicy's drawer)
  const selectorStr = useMemo(
    () => (selector ? selectorText({ matchLabels: selector, matchExpressions: selectorExpressions }) : ''),
    [selector, selectorExpressions],
  )

  const podsKind = kind === 'DaemonSet' || kind === 'ReplicaSet' || kind === 'StatefulSet' || kind === 'Job' || kind === 'Deployment'
  const podsEnabled = podsKind && !!namespace && !!selectorStr
  const rsEnabled = kind === 'Deployment' && !!namespace && !!selectorStr
  const byOwner = kind !== 'Deployment'
  const keeps = useCallback((p: PodInfo) => !byOwner || podOwnedBy(p, kind, name), [byOwner, kind, name])

  const podTable = useNamespacePodTable({
    enabled: podsEnabled,
    namespace: namespace ?? '',
    filter: byOwner ? { label_selector: selectorStr, owner: `${kind}/${name}` } : { label_selector: selectorStr },
    queryKey: ['owned-watched-pods', kind, namespace, name, selectorStr],
    keeps,
    selector: selectorStr,
    line: SET_POD_TABLE_WATCH_MAX,
  })
  const pods: PodTableRow[] | undefined = podTable.whole ?? podTable.page?.items
  const pageTotal = podTable.page?.total
  const pageNotRunning = podTable.page?.not_running
  const counted = useMemo(() => (pageTotal === undefined ? undefined : { total: pageTotal, notRunning: pageNotRunning }), [pageTotal, pageNotRunning])

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

  // CronJob 의 owned Jobs — useWorkloadData 의 기존 api.getCronJobOwnedJobs
  // (backend 가 owner match 한 list 반환) 가 useQuery 만 사용했음. 여기에 watch
  // 추가로 kubectl 로 Job 생성/완료 시 모달이 즉시 반영.
  const jobsEnabled = kind === 'CronJob' && !!namespace && !!name

  const { data: ownedJobsLive } = useQuery({
    queryKey: ['owned-watched-jobs', namespace, name],
    queryFn: async () => {
      const all = await api.getJobs(namespace as string)
      return all.filter((j: any) => {
        const refs = j?.owner_references || j?.metadata?.ownerReferences || []
        return Array.isArray(refs) && refs.some((r: any) => r?.name === name && r?.kind === 'CronJob')
      })
    },
    enabled: jobsEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: jobsEnabled,
    queryKey: ['owned-watched-jobs', namespace, name],
    path: `/apis/batch/v1/namespaces/${namespace}/jobs`,
    query: 'watch=1',
    applyEvent: (prev, event) => {
      const next = applyJobWatchEvent(prev as JobInfo[] | undefined, event)
      return next.filter((j: any) => {
        const refs = j?.owner_references || []
        return Array.isArray(refs) && refs.some((r: any) => r?.name === name && r?.kind === 'CronJob')
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
    counted,
    podTable,
    replicaSets: Array.isArray(replicaSets) ? replicaSets : [],
    jobs: Array.isArray(ownedJobsLive) ? ownedJobsLive : [],
    pvcsByPodName,
    podsEnabled,
    podsLoaded: Array.isArray(pods),
    rsEnabled,
    jobsEnabled,
    pvcsEnabled,
  }
}
