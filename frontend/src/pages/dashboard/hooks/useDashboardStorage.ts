import { useMemo } from 'react'

// Dashboard StorageModal 의 derived 데이터 (filter + sort + status counts) 분리.
// Dashboard.tsx 의 84줄 inline block (storage namespace dropdown / filtered+sorted
// PVC + PV / status pill counts / loading flag) 을 useMemo 로 안정화.

interface Params {
  allPVCs: any
  allPVs: any
  allNamespaces: any
  storageSearchQuery: string
  storageNamespaceFilter: string
  storageActiveTab: 'pvcs' | 'pvs' | 'topology'
  isStorageModalOpen: boolean
  isLoadingPVCs: boolean
  isLoadingPVs: boolean
  isLoadingStorageTopology: boolean
}

interface Result {
  storageNamespaces: string[]
  filteredPVCsForStorage: any[]
  filteredPVsForStorage: any[]
  sortedPVCsForStorage: any[]
  sortedPVsForStorage: any[]
  pvcStatusCounts: Record<string, number>
  pvStatusCounts: Record<string, number>
  isStorageLoading: boolean
}

// PVC 는 Pending/Lost 가 사용자 액션 필요 상태 → 위, Bound 가 정상 → 아래.
const PVC_STATUS_RANK: Record<string, number> = { Pending: 0, Lost: 1, Bound: 2 }
// PV 는 Failed 가 가장 critical, Bound 는 PVC 와 결합되어 있으니 마지막.
const PV_STATUS_RANK: Record<string, number> = { Failed: 0, Released: 1, Available: 2, Bound: 3 }

export function useDashboardStorage({
  allPVCs,
  allPVs,
  allNamespaces,
  storageSearchQuery,
  storageNamespaceFilter,
  storageActiveTab,
  isStorageModalOpen,
  isLoadingPVCs,
  isLoadingPVs,
  isLoadingStorageTopology,
}: Params): Result {
  return useMemo(() => {
    const allPVCsArray = Array.isArray(allPVCs) ? allPVCs : []
    const allPVsArray = Array.isArray(allPVs) ? allPVs : []
    const normalizedStorageQuery = storageSearchQuery.trim().toLowerCase()

    const storageNamespaces = (() => {
      const fromApi = Array.isArray(allNamespaces)
        ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean)
        : []
      const fromPVCs = allPVCsArray.map((pvc: any) => String(pvc?.namespace ?? '')).filter(Boolean)
      return Array.from(new Set([...fromApi, ...fromPVCs])).sort()
    })()

    const filteredPVCsForStorage = allPVCsArray
      .filter((pvc: any) =>
        storageNamespaceFilter === 'all' ? true : String(pvc?.namespace ?? '') === storageNamespaceFilter,
      )
      .filter((pvc: any) => {
        if (!normalizedStorageQuery) return true
        const haystack = [
          pvc?.name, pvc?.namespace, pvc?.status,
          pvc?.storage_class, pvc?.volume_name, pvc?.capacity,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(normalizedStorageQuery)
      })

    const filteredPVsForStorage = allPVsArray
      .filter((pv: any) => {
        if (storageNamespaceFilter === 'all') return true
        const claimNs = pv?.claim_ref?.namespace
        return claimNs && String(claimNs) === storageNamespaceFilter
      })
      .filter((pv: any) => {
        if (!normalizedStorageQuery) return true
        const haystack = [
          pv?.name, pv?.status, pv?.capacity, pv?.storage_class,
          pv?.reclaim_policy, pv?.claim_ref?.namespace, pv?.claim_ref?.name,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(normalizedStorageQuery)
      })

    const pvcStatusCounts = filteredPVCsForStorage.reduce<Record<string, number>>((acc, pvc: any) => {
      const status = String(pvc?.status ?? 'Unknown')
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})

    const pvStatusCounts = filteredPVsForStorage.reduce<Record<string, number>>((acc, pv: any) => {
      const status = String(pv?.status ?? 'Unknown')
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})

    const sortedPVCsForStorage = [...filteredPVCsForStorage].sort((a: any, b: any) => {
      const ar = PVC_STATUS_RANK[String(a?.status ?? '')] ?? 99
      const br = PVC_STATUS_RANK[String(b?.status ?? '')] ?? 99
      if (ar !== br) return ar - br
      const an = `${a?.namespace ?? ''}/${a?.name ?? ''}`
      const bn = `${b?.namespace ?? ''}/${b?.name ?? ''}`
      return an.localeCompare(bn)
    })

    const sortedPVsForStorage = [...filteredPVsForStorage].sort((a: any, b: any) => {
      const ar = PV_STATUS_RANK[String(a?.status ?? '')] ?? 99
      const br = PV_STATUS_RANK[String(b?.status ?? '')] ?? 99
      if (ar !== br) return ar - br
      const an = String(a?.name ?? '')
      const bn = String(b?.name ?? '')
      return an.localeCompare(bn)
    })

    const isStorageLoading =
      isStorageModalOpen &&
      (isLoadingPVCs || isLoadingPVs || (storageActiveTab === 'topology' && isLoadingStorageTopology))

    return {
      storageNamespaces,
      filteredPVCsForStorage,
      filteredPVsForStorage,
      sortedPVCsForStorage,
      sortedPVsForStorage,
      pvcStatusCounts,
      pvStatusCounts,
      isStorageLoading,
    }
  }, [
    allPVCs, allPVs, allNamespaces,
    storageSearchQuery, storageNamespaceFilter, storageActiveTab,
    isStorageModalOpen, isLoadingPVCs, isLoadingPVs, isLoadingStorageTopology,
  ])
}
