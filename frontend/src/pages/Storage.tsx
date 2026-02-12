import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { Database, HardDrive, RefreshCw, Search, X, ExternalLink, ArrowDown, ArrowUp } from 'lucide-react'

type StorageTab = 'pvcs' | 'pvs' | 'storageclasses' | 'volumeattachments'
type PvcSortKey =
  | 'namespace'
  | 'name'
  | 'status'
  | 'age'
  | 'storage_class'
  | 'volume_name'
  | 'requested'
  | 'capacity'
  | 'access_modes'
type PvSortKey =
  | 'name'
  | 'status'
  | 'age'
  | 'capacity'
  | 'storage_class'
  | 'source_driver'
  | 'volume_handle'
  | 'volume_mode'
  | 'node_affinity'
  | 'reclaim_policy'
  | 'access_modes'
  | 'claim'

export default function Storage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<StorageTab>('pvcs')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [selectedPvc, setSelectedPvc] = useState<any | null>(null)
  const [pvcSort, setPvcSort] = useState<{ key: PvcSortKey; dir: 'asc' | 'desc' }>({
    key: 'namespace',
    dir: 'asc',
  })
  const [pvSort, setPvSort] = useState<{ key: PvSortKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc',
  })

  const formatAge = (iso?: string | null) => {
    if (!iso) return '-'
    const createdAt = new Date(iso)
    const createdMs = createdAt.getTime()
    if (Number.isNaN(createdMs)) return '-'

    const diffSec = Math.max(0, Math.floor((Date.now() - createdMs) / 1000))
    const days = Math.floor(diffSec / 86400)
    const hours = Math.floor((diffSec % 86400) / 3600)
    const minutes = Math.floor((diffSec % 3600) / 60)

    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  const parseQuantityToBytes = useCallback((value?: string | null): number | null => {
    if (!value) return null
    const s = value.toString().trim()
    if (!s) return null

    const m = s.match(/^([0-9]+(?:\\.[0-9]+)?)([a-zA-Z]+)?$/)
    if (!m) return null

    const num = Number(m[1])
    if (Number.isNaN(num)) return null
    const unit = (m[2] || '').trim()

    const bin: Record<string, number> = {
      Ki: 1024 ** 1,
      Mi: 1024 ** 2,
      Gi: 1024 ** 3,
      Ti: 1024 ** 4,
      Pi: 1024 ** 5,
      Ei: 1024 ** 6,
    }
    const dec: Record<string, number> = {
      K: 1000 ** 1,
      M: 1000 ** 2,
      G: 1000 ** 3,
      T: 1000 ** 4,
      P: 1000 ** 5,
      E: 1000 ** 6,
    }

    if (!unit) return num
    if (bin[unit] !== undefined) return num * bin[unit]
    if (dec[unit] !== undefined) return num * dec[unit]
    return null
  }, [])

  useEffect(() => {
    if (activeTab !== 'pvcs') setSelectedPvc(null)
  }, [activeTab])

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false),
    staleTime: 30000,
  })

  const { data: pvcs } = useQuery({
    queryKey: ['storage', 'pvcs', selectedNamespace],
    queryFn: () => api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, false),
    enabled: activeTab === 'pvcs',
  })

  const shouldFetchPvs = activeTab === 'pvs' || (activeTab === 'pvcs' && !!selectedPvc?.volume_name)
  const shouldFetchStorageClasses = activeTab === 'storageclasses' || (activeTab === 'pvcs' && !!selectedPvc?.storage_class)

  const { data: pvs, isLoading: isPvsLoading } = useQuery({
    queryKey: ['storage', 'pvs'],
    queryFn: () => api.getPVs(),
    enabled: shouldFetchPvs,
  })

  const { data: storageClasses, isLoading: isStorageClassesLoading } = useQuery({
    queryKey: ['storage', 'storageclasses'],
    queryFn: () => api.getStorageClasses(false),
    enabled: shouldFetchStorageClasses,
  })

  const { data: volumeAttachments, error: volumeAttachmentError } = useQuery({
    queryKey: ['storage', 'volumeattachments'],
    queryFn: () => api.getVolumeAttachments(false),
    enabled: activeTab === 'volumeattachments',
    retry: 0,
  })

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filterByPredicate = (items: any[] | undefined | null, predicate: (it: any) => boolean) => {
      if (!Array.isArray(items)) return []
      if (!q) return items
      return items.filter(predicate)
    }

    const includes = (value: any) => (value ?? '').toString().toLowerCase().includes(q)
    const includesAny = (values: any[] | undefined | null) => (values || []).some((v) => includes(v))

    if (activeTab === 'pvcs') {
      return filterByPredicate(pvcs, (pvc: any) => {
        return (
          includes(pvc?.name) ||
          includes(pvc?.namespace) ||
          includes(pvc?.status) ||
          includes(pvc?.storage_class) ||
          includes(pvc?.volume_name) ||
          includes(pvc?.requested) ||
          includes(pvc?.capacity) ||
          includesAny(pvc?.access_modes)
        )
      })
    }
    if (activeTab === 'pvs') {
      return filterByPredicate(pvs, (pv: any) => {
        const claim = pv?.claim_ref?.namespace && pv?.claim_ref?.name ? `${pv.claim_ref.namespace}/${pv.claim_ref.name}` : ''
        return (
          includes(pv?.name) ||
          includes(pv?.status) ||
          includes(pv?.storage_class) ||
          includes(pv?.capacity) ||
          includes(pv?.reclaim_policy) ||
          includes(pv?.source) ||
          includes(pv?.driver) ||
          includes(pv?.volume_handle) ||
          includes(pv?.volume_mode) ||
          includes(pv?.node_affinity) ||
          includesAny(pv?.access_modes) ||
          includes(claim)
        )
      })
    }
    if (activeTab === 'storageclasses') {
      return filterByPredicate(storageClasses, (sc: any) => {
        return (
          includes(sc?.name) ||
          includes(sc?.provisioner) ||
          includes(sc?.reclaim_policy) ||
          includes(sc?.volume_binding_mode) ||
          includes(sc?.allow_volume_expansion) ||
          includes(sc?.is_default)
        )
      })
    }
    if (activeTab === 'volumeattachments') {
      return filterByPredicate(volumeAttachments as any, (va: any) => {
        return (
          includes(va?.name) ||
          includes(va?.node_name) ||
          includes(va?.persistent_volume_name) ||
          includes(va?.attacher) ||
          includes(va?.attached) ||
          includes(va?.attach_error?.message) ||
          includes(va?.detach_error?.message)
        )
      })
    }
    return []
  }, [activeTab, pvcs, pvs, storageClasses, volumeAttachments, searchQuery])

  const sortedPvcItems = useMemo(() => {
    if (activeTab !== 'pvcs') return filteredItems
    const items = (filteredItems || []) as any[]
    const dirMul = pvcSort.dir === 'asc' ? 1 : -1

    const strCmp = (a: any, b: any) => a.toString().localeCompare(b.toString())
    const safeStr = (v: any) => (v ?? '').toString()

    const getAgeMs = (pvc: any) => {
      const t = pvc?.created_at ? new Date(pvc.created_at).getTime() : NaN
      return Number.isNaN(t) ? null : t
    }

    const getSize = (pvc: any, field: 'requested' | 'capacity') => parseQuantityToBytes(pvc?.[field])

    const cmpNullableNumber = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    }

    const cmpNullableString = (a: string, b: string) => {
      const aa = safeStr(a).trim()
      const bb = safeStr(b).trim()
      if (!aa && !bb) return 0
      if (!aa) return 1
      if (!bb) return -1
      return strCmp(aa, bb)
    }

    const compare = (a: any, b: any) => {
      switch (pvcSort.key) {
        case 'namespace':
          return cmpNullableString(a?.namespace, b?.namespace)
        case 'name':
          return cmpNullableString(a?.name, b?.name)
        case 'status':
          return cmpNullableString(a?.status, b?.status)
        case 'storage_class':
          return cmpNullableString(a?.storage_class, b?.storage_class)
        case 'volume_name':
          return cmpNullableString(a?.volume_name, b?.volume_name)
        case 'access_modes':
          return cmpNullableString((a?.access_modes || []).join(','), (b?.access_modes || []).join(','))
        case 'age':
          return cmpNullableNumber(getAgeMs(a), getAgeMs(b))
        case 'requested':
          return cmpNullableNumber(getSize(a, 'requested'), getSize(b, 'requested'))
        case 'capacity':
          return cmpNullableNumber(getSize(a, 'capacity'), getSize(b, 'capacity'))
        default:
          return 0
      }
    }

    return items.slice().sort((a, b) => compare(a, b) * dirMul)
  }, [activeTab, filteredItems, pvcSort, parseQuantityToBytes])

  const sortedPvItems = useMemo(() => {
    if (activeTab !== 'pvs') return filteredItems
    const items = (filteredItems || []) as any[]
    const dirMul = pvSort.dir === 'asc' ? 1 : -1

    const safeStr = (v: any) => (v ?? '').toString()
    const strCmp = (a: any, b: any) => a.toString().localeCompare(b.toString())

    const getAgeMs = (pv: any) => {
      const t = pv?.created_at ? new Date(pv.created_at).getTime() : NaN
      return Number.isNaN(t) ? null : t
    }

    const getSize = (pv: any) => parseQuantityToBytes(pv?.capacity)

    const claimStr = (pv: any) =>
      pv?.claim_ref?.namespace && pv?.claim_ref?.name ? `${pv.claim_ref.namespace}/${pv.claim_ref.name}` : ''

    const sourceDriverStr = (pv: any) => {
      if (!pv?.source) return ''
      if (!pv?.driver) return pv.source
      return `${pv.source} · ${pv.driver}`
    }

    const cmpNullableNumber = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    }

    const cmpNullableString = (a: string, b: string) => {
      const aa = safeStr(a).trim()
      const bb = safeStr(b).trim()
      if (!aa && !bb) return 0
      if (!aa) return 1
      if (!bb) return -1
      return strCmp(aa, bb)
    }

    const compare = (a: any, b: any) => {
      switch (pvSort.key) {
        case 'name':
          return cmpNullableString(a?.name, b?.name)
        case 'status':
          return cmpNullableString(a?.status, b?.status)
        case 'age':
          return cmpNullableNumber(getAgeMs(a), getAgeMs(b))
        case 'capacity':
          return cmpNullableNumber(getSize(a), getSize(b))
        case 'storage_class':
          return cmpNullableString(a?.storage_class, b?.storage_class)
        case 'source_driver':
          return cmpNullableString(sourceDriverStr(a), sourceDriverStr(b))
        case 'volume_handle':
          return cmpNullableString(a?.volume_handle, b?.volume_handle)
        case 'volume_mode':
          return cmpNullableString(a?.volume_mode, b?.volume_mode)
        case 'node_affinity':
          return cmpNullableString(a?.node_affinity, b?.node_affinity)
        case 'reclaim_policy':
          return cmpNullableString(a?.reclaim_policy, b?.reclaim_policy)
        case 'access_modes':
          return cmpNullableString((a?.access_modes || []).join(','), (b?.access_modes || []).join(','))
        case 'claim':
          return cmpNullableString(claimStr(a), claimStr(b))
        default:
          return 0
      }
    }

    return items.slice().sort((a, b) => compare(a, b) * dirMul)
  }, [activeTab, filteredItems, pvSort, parseQuantityToBytes])

  const selectedPv = useMemo(() => {
    if (!selectedPvc?.volume_name) return null
    return (pvs || []).find((pv: any) => pv?.name === selectedPvc.volume_name) || null
  }, [pvs, selectedPvc?.volume_name])

  const selectedStorageClass = useMemo(() => {
    if (!selectedPvc?.storage_class) return null
    return (storageClasses || []).find((sc: any) => sc?.name === selectedPvc.storage_class) || null
  }, [storageClasses, selectedPvc?.storage_class])

  const togglePvcSort = (key: PvcSortKey) => {
    setPvcSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: 'asc' }
    })
  }

  const togglePvSort = (key: PvSortKey) => {
    setPvSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: 'asc' }
    })
  }

  const SortIcon = ({ colKey }: { colKey: PvcSortKey }) => {
    if (pvcSort.key !== colKey) return null
    return pvcSort.dir === 'asc' ? (
      <ArrowUp className="w-3.5 h-3.5 text-slate-400" />
    ) : (
      <ArrowDown className="w-3.5 h-3.5 text-slate-400" />
    )
  }

  const PvSortIcon = ({ colKey }: { colKey: PvSortKey }) => {
    if (pvSort.key !== colKey) return null
    return pvSort.dir === 'asc' ? (
      <ArrowUp className="w-3.5 h-3.5 text-slate-400" />
    ) : (
      <ArrowDown className="w-3.5 h-3.5 text-slate-400" />
    )
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      if (activeTab === 'pvcs') {
        const data = await api.getPVCs(selectedNamespace === 'all' ? undefined : selectedNamespace, true)
        queryClient.removeQueries({ queryKey: ['storage', 'pvcs', selectedNamespace] })
        queryClient.setQueryData(['storage', 'pvcs', selectedNamespace], data)
        setSelectedPvc((prev: any) => {
          if (!prev) return prev
          const found = (data as any[]).find((p) => p?.namespace === prev?.namespace && p?.name === prev?.name)
          return found || prev
        })
      } else if (activeTab === 'storageclasses') {
        const data = await api.getStorageClasses(true)
        queryClient.removeQueries({ queryKey: ['storage', 'storageclasses'] })
        queryClient.setQueryData(['storage', 'storageclasses'], data)
      } else if (activeTab === 'volumeattachments') {
        const data = await api.getVolumeAttachments(true)
        queryClient.removeQueries({ queryKey: ['storage', 'volumeattachments'] })
        queryClient.setQueryData(['storage', 'volumeattachments'], data)
      } else if (activeTab === 'pvs') {
        const data = await api.getPVs()
        queryClient.removeQueries({ queryKey: ['storage', 'pvs'] })
        queryClient.setQueryData(['storage', 'pvs'], data)
      }
    } catch (e) {
      console.error('새로고침 실패:', e)
    } finally {
      setTimeout(() => setIsRefreshing(false), 500)
    }
  }

  const tabs: Array<{ id: StorageTab; name: string; icon: any }> = [
    { id: 'pvcs', name: 'PVC', icon: Database },
    { id: 'pvs', name: 'PV', icon: HardDrive },
    { id: 'storageclasses', name: 'StorageClass', icon: Database },
    { id: 'volumeattachments', name: 'VolumeAttachment', icon: HardDrive },
  ]

  const searchPlaceholder: Record<StorageTab, string> = {
    pvcs: 'PVC 이름 검색...',
    pvs: 'PV 이름 검색...',
    storageclasses: 'StorageClass 이름 검색...',
    volumeattachments: 'VolumeAttachment 이름 검색...',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">스토리지</h1>
          <p className="mt-2 text-slate-400">PV/PVC/StorageClass/VolumeAttachment를 한 곳에서 확인하세요</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="새로고침 (강제 갱신)"
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      <div className="flex gap-2 border-b border-slate-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              flex items-center gap-2 px-4 py-3 font-medium transition-colors
              border-b-2 -mb-px
              ${activeTab === tab.id
                ? 'border-primary-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
              }
            `}
          >
            <tab.icon className="w-4 h-4" />
            {tab.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={searchPlaceholder[activeTab]}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        {activeTab === 'pvcs' ? (
          <div>
            <select
              value={selectedNamespace}
              onChange={(e) => setSelectedNamespace(e.target.value)}
              className="w-full py-3 px-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              <option value="all">전체 네임스페이스</option>
              {(namespaces || []).map((ns) => (
                <option key={ns.name} value={ns.name}>
                  {ns.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div />
        )}
      </div>

      {activeTab === 'volumeattachments' && volumeAttachmentError && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-200">
          VolumeAttachment 조회에 실패했습니다. (클러스터 권한/환경에 따라 불가할 수 있습니다)
        </div>
      )}

      {/* Lists */}
      {activeTab === 'pvcs' && (
        (() => {
          const pvcTable = (tableCardClassName: string) => (
            <div className={tableCardClassName}>
              <table className="w-full text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('namespace')}>
                    <div className="flex items-center gap-2">
                      Namespace <SortIcon colKey="namespace" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('name')}>
                    <div className="flex items-center gap-2">
                      Name <SortIcon colKey="name" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('status')}>
                    <div className="flex items-center gap-2">
                      Status <SortIcon colKey="status" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('age')}>
                    <div className="flex items-center gap-2">
                      Age <SortIcon colKey="age" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('storage_class')}>
                    <div className="flex items-center gap-2">
                      StorageClass <SortIcon colKey="storage_class" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('volume_name')}>
                    <div className="flex items-center gap-2">
                      Volume <SortIcon colKey="volume_name" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('requested')}>
                    <div className="flex items-center gap-2">
                      Requested <SortIcon colKey="requested" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('capacity')}>
                    <div className="flex items-center gap-2">
                      Capacity <SortIcon colKey="capacity" />
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvcSort('access_modes')}>
                    <div className="flex items-center gap-2">
                      AccessModes <SortIcon colKey="access_modes" />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {sortedPvcItems.map((pvc: any) => {
                  const isSelected = selectedPvc?.namespace === pvc.namespace && selectedPvc?.name === pvc.name
                  return (
                    <tr
                      key={`${pvc.namespace}/${pvc.name}`}
                      className={`cursor-pointer ${isSelected ? 'bg-primary-600/15' : 'hover:bg-slate-700/30'}`}
                      onClick={() => setSelectedPvc(pvc)}
                      title="클릭하면 PV/StorageClass 연결 정보를 확인합니다"
                    >
                      <td className="py-3 px-4 text-slate-300">{pvc.namespace}</td>
                      <td className="py-3 px-4 text-white font-mono">{pvc.name}</td>
                      <td className="py-3 px-4 text-slate-200">{pvc.status}</td>
                      <td
                        className="py-3 px-4 text-slate-200 font-mono whitespace-nowrap"
                        title={pvc.created_at ? new Date(pvc.created_at).toLocaleString('ko-KR') : ''}
                      >
                        {formatAge(pvc.created_at)}
                      </td>
                      <td className="py-3 px-4 text-slate-200 font-mono">{pvc.storage_class || '-'}</td>
                      <td className="py-3 px-4 text-slate-200 font-mono">{pvc.volume_name || '-'}</td>
                      <td className="py-3 px-4 text-slate-200 font-mono">{pvc.requested || '-'}</td>
                      <td className="py-3 px-4 text-slate-200 font-mono">{pvc.capacity || '-'}</td>
                      <td className="py-3 px-4 text-slate-200">{(pvc.access_modes || []).join(', ') || '-'}</td>
                    </tr>
                  )
                })}
                {filteredItems.length === 0 && (
                  <tr>
                    <td className="py-6 px-4 text-slate-400" colSpan={9}>
                      (없음)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          )

          if (!selectedPvc) {
            return pvcTable('card overflow-x-auto')
          }

          return (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {pvcTable('card overflow-x-auto xl:col-span-2')}

              <div className="card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-white">연결 보기</h3>
                    <p className="text-sm text-slate-400 mt-1">PVC → PV / StorageClass</p>
                  </div>
                  <button
                    onClick={() => setSelectedPvc(null)}
                    className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                    title="닫기"
                  >
                    <X className="w-4 h-4 text-slate-300" />
                  </button>
                </div>

                <div className="mt-4 space-y-5">
                <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-400">PVC</div>
                      <div className="text-white font-mono break-words">{selectedPvc.namespace}/{selectedPvc.name}</div>
                      <div className="text-sm text-slate-300 mt-1">Status: {selectedPvc.status}</div>
                    </div>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <button
                        onClick={() => {
                          setSearchQuery(selectedPvc.name)
                        }}
                        className="text-xs text-slate-300 hover:text-white flex items-center gap-1"
                        title="검색어로 설정"
                      >
                        <ExternalLink className="w-3 h-3" />
                        검색
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-slate-400">StorageClass</div>
                      <div className="text-slate-200 font-mono break-words">{selectedPvc.storage_class || '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">PV</div>
                      <div className="text-slate-200 font-mono break-words">{selectedPvc.volume_name || '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">Requested</div>
                      <div className="text-slate-200 font-mono">{selectedPvc.requested || '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">Capacity</div>
                      <div className="text-slate-200 font-mono">{selectedPvc.capacity || '-'}</div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-white font-semibold">PV 요약</div>
                    {selectedPvc.volume_name && (
                      <button
                        onClick={() => {
                          setActiveTab('pvs')
                          setSearchQuery(selectedPvc.volume_name)
                        }}
                        className="text-xs text-slate-300 hover:text-white flex items-center gap-1"
                        title="PV 탭으로 이동"
                      >
                        <ExternalLink className="w-3 h-3" />
                        PV로 이동
                      </button>
                    )}
                  </div>
                  <div className="mt-3 text-sm text-slate-300">
                    {isPvsLoading ? (
                      <div className="text-slate-400">로딩 중...</div>
                    ) : !selectedPvc.volume_name ? (
                      <div className="text-slate-400">(PV 없음)</div>
                    ) : !selectedPv ? (
                      <div className="text-slate-400">(조회 실패 또는 없음)</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs text-slate-400">Status</div>
                          <div className="text-slate-200">{selectedPv.status}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">Capacity</div>
                          <div className="text-slate-200 font-mono">{selectedPv.capacity}</div>
                        </div>
                        <div className="col-span-2">
                          <div className="text-xs text-slate-400">Claim</div>
                          <div className="text-slate-200 font-mono break-words">
                            {selectedPv.claim_ref?.namespace && selectedPv.claim_ref?.name
                              ? `${selectedPv.claim_ref.namespace}/${selectedPv.claim_ref.name}`
                              : '-'}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-white font-semibold">StorageClass 요약</div>
                    {selectedPvc.storage_class && (
                      <button
                        onClick={() => {
                          setActiveTab('storageclasses')
                          setSearchQuery(selectedPvc.storage_class)
                        }}
                        className="text-xs text-slate-300 hover:text-white flex items-center gap-1"
                        title="StorageClass 탭으로 이동"
                      >
                        <ExternalLink className="w-3 h-3" />
                        SC로 이동
                      </button>
                    )}
                  </div>
                  <div className="mt-3 text-sm text-slate-300">
                    {isStorageClassesLoading ? (
                      <div className="text-slate-400">로딩 중...</div>
                    ) : !selectedPvc.storage_class ? (
                      <div className="text-slate-400">(StorageClass 없음)</div>
                    ) : !selectedStorageClass ? (
                      <div className="text-slate-400">(조회 실패 또는 없음)</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                          <div className="text-xs text-slate-400">Provisioner</div>
                          <div className="text-slate-200 font-mono break-words">{selectedStorageClass.provisioner}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">Default</div>
                          <div className="text-slate-200">{selectedStorageClass.is_default ? 'true' : 'false'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">BindingMode</div>
                          <div className="text-slate-200">{selectedStorageClass.volume_binding_mode || '-'}</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          )
        })()
      )}

      {activeTab === 'pvs' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('name')}>
                  <div className="flex items-center gap-2">
                    Name <PvSortIcon colKey="name" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('status')}>
                  <div className="flex items-center gap-2">
                    Status <PvSortIcon colKey="status" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('age')}>
                  <div className="flex items-center gap-2">
                    Age <PvSortIcon colKey="age" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('capacity')}>
                  <div className="flex items-center gap-2">
                    Capacity <PvSortIcon colKey="capacity" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('storage_class')}>
                  <div className="flex items-center gap-2">
                    StorageClass <PvSortIcon colKey="storage_class" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('source_driver')}>
                  <div className="flex items-center gap-2">
                    Source/Driver <PvSortIcon colKey="source_driver" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('volume_handle')}>
                  <div className="flex items-center gap-2">
                    VolumeHandle <PvSortIcon colKey="volume_handle" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('volume_mode')}>
                  <div className="flex items-center gap-2">
                    VolumeMode <PvSortIcon colKey="volume_mode" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('node_affinity')}>
                  <div className="flex items-center gap-2">
                    NodeAffinity <PvSortIcon colKey="node_affinity" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('reclaim_policy')}>
                  <div className="flex items-center gap-2">
                    Reclaim <PvSortIcon colKey="reclaim_policy" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('access_modes')}>
                  <div className="flex items-center gap-2">
                    AccessModes <PvSortIcon colKey="access_modes" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => togglePvSort('claim')}>
                  <div className="flex items-center gap-2">
                    Claim <PvSortIcon colKey="claim" />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {sortedPvItems.map((pv: any) => (
                <tr key={pv.name}>
                  <td className="py-3 px-4 text-white font-mono">{pv.name}</td>
                  <td className="py-3 px-4 text-slate-200">{pv.status}</td>
                  <td
                    className="py-3 px-4 text-slate-200 font-mono whitespace-nowrap"
                    title={pv.created_at ? new Date(pv.created_at).toLocaleString('ko-KR') : ''}
                  >
                    {formatAge(pv.created_at)}
                  </td>
                  <td className="py-3 px-4 text-slate-200 font-mono">{pv.capacity || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono">{pv.storage_class || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono break-words">
                    {pv.source ? (pv.driver ? `${pv.source} · ${pv.driver}` : pv.source) : '-'}
                  </td>
                  <td className="py-3 px-4 text-slate-200 font-mono break-words">{pv.volume_handle || '-'}</td>
                  <td className="py-3 px-4 text-slate-200">{pv.volume_mode || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono break-words" title={pv.node_affinity || ''}>
                    {pv.node_affinity || '-'}
                  </td>
                  <td className="py-3 px-4 text-slate-200">{pv.reclaim_policy}</td>
                  <td className="py-3 px-4 text-slate-200">{(pv.access_modes || []).join(', ') || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono">
                    {pv.claim_ref?.namespace && pv.claim_ref?.name ? `${pv.claim_ref.namespace}/${pv.claim_ref.name}` : '-'}
                  </td>
                </tr>
              ))}
              {sortedPvItems.length === 0 && (
                <tr>
                  <td className="py-6 px-4 text-slate-400" colSpan={12}>
                    (없음)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'storageclasses' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4">Name</th>
                <th className="text-left py-3 px-4">Default</th>
                <th className="text-left py-3 px-4">Provisioner</th>
                <th className="text-left py-3 px-4">BindingMode</th>
                <th className="text-left py-3 px-4">AllowExpansion</th>
                <th className="text-left py-3 px-4">Reclaim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredItems.map((sc: any) => (
                <tr key={sc.name}>
                  <td className="py-3 px-4 text-white font-mono">{sc.name}</td>
                  <td className="py-3 px-4">
                    {sc.is_default ? <span className="badge badge-success">default</span> : <span className="text-slate-500">-</span>}
                  </td>
                  <td className="py-3 px-4 text-slate-200 font-mono break-words">{sc.provisioner}</td>
                  <td className="py-3 px-4 text-slate-200">{sc.volume_binding_mode || '-'}</td>
                  <td className="py-3 px-4 text-slate-200">{sc.allow_volume_expansion === true ? 'true' : sc.allow_volume_expansion === false ? 'false' : '-'}</td>
                  <td className="py-3 px-4 text-slate-200">{sc.reclaim_policy || '-'}</td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td className="py-6 px-4 text-slate-400" colSpan={6}>
                    (없음)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'volumeattachments' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4">Name</th>
                <th className="text-left py-3 px-4">Attached</th>
                <th className="text-left py-3 px-4">PV</th>
                <th className="text-left py-3 px-4">Node</th>
                <th className="text-left py-3 px-4">Attacher</th>
                <th className="text-left py-3 px-4">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredItems.map((va: any) => (
                <tr key={va.name}>
                  <td className="py-3 px-4 text-white font-mono">{va.name}</td>
                  <td className="py-3 px-4 text-slate-200">
                    {va.attached === true ? 'true' : va.attached === false ? 'false' : '-'}
                  </td>
                  <td className="py-3 px-4 text-slate-200 font-mono">{va.persistent_volume_name || '-'}</td>
                  <td className="py-3 px-4 text-slate-200">{va.node_name || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono break-words">{va.attacher || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 break-words">
                    {va.attach_error?.message || va.detach_error?.message || '-'}
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td className="py-6 px-4 text-slate-400" colSpan={6}>
                    (없음)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
