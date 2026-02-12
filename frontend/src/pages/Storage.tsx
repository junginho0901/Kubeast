import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { Database, HardDrive, RefreshCw, Search, X, ExternalLink } from 'lucide-react'

type StorageTab = 'pvcs' | 'pvs' | 'storageclasses' | 'volumeattachments'

export default function Storage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<StorageTab>('pvcs')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [selectedPvc, setSelectedPvc] = useState<any | null>(null)

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

  const { data: selectedPv, isLoading: isSelectedPvLoading } = useQuery({
    queryKey: ['storage', 'pv', selectedPvc?.volume_name],
    queryFn: async () => {
      if (!selectedPvc?.volume_name) return null
      return await api.getPV(selectedPvc.volume_name)
    },
    enabled: activeTab === 'pvcs' && !!selectedPvc?.volume_name,
    retry: 0,
  })

  const { data: selectedStorageClass, isLoading: isSelectedScLoading } = useQuery({
    queryKey: ['storage', 'storageclass', selectedPvc?.storage_class],
    queryFn: async () => {
      if (!selectedPvc?.storage_class) return null
      return await api.getStorageClass(selectedPvc.storage_class)
    },
    enabled: activeTab === 'pvcs' && !!selectedPvc?.storage_class,
    retry: 0,
  })

  const { data: pvs } = useQuery({
    queryKey: ['storage', 'pvs'],
    queryFn: () => api.getPVs(),
    enabled: activeTab === 'pvs',
  })

  const { data: storageClasses } = useQuery({
    queryKey: ['storage', 'storageclasses'],
    queryFn: () => api.getStorageClasses(false),
    enabled: activeTab === 'storageclasses',
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
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="card overflow-x-auto xl:col-span-2">
            <table className="w-full text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-3 px-4">Namespace</th>
                  <th className="text-left py-3 px-4">Name</th>
                  <th className="text-left py-3 px-4">Status</th>
                  <th className="text-left py-3 px-4">Age</th>
                  <th className="text-left py-3 px-4">StorageClass</th>
                  <th className="text-left py-3 px-4">Volume</th>
                  <th className="text-left py-3 px-4">Requested</th>
                  <th className="text-left py-3 px-4">Capacity</th>
                  <th className="text-left py-3 px-4">AccessModes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {filteredItems.map((pvc: any) => {
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

          <div className="card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">연결 보기</h3>
                <p className="text-sm text-slate-400 mt-1">PVC → PV / StorageClass</p>
              </div>
              {selectedPvc && (
                <button
                  onClick={() => setSelectedPvc(null)}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                  title="닫기"
                >
                  <X className="w-4 h-4 text-slate-300" />
                </button>
              )}
            </div>

            {!selectedPvc ? (
              <div className="mt-4 text-slate-400 text-sm">(PVC 행을 클릭하세요)</div>
            ) : (
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
                    {isSelectedPvLoading ? (
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
                    {isSelectedScLoading ? (
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
            )}
          </div>
        </div>
      )}

      {activeTab === 'pvs' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4">Name</th>
                <th className="text-left py-3 px-4">Status</th>
                <th className="text-left py-3 px-4">Capacity</th>
                <th className="text-left py-3 px-4">StorageClass</th>
                <th className="text-left py-3 px-4">Reclaim</th>
                <th className="text-left py-3 px-4">AccessModes</th>
                <th className="text-left py-3 px-4">Claim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredItems.map((pv: any) => (
                <tr key={pv.name}>
                  <td className="py-3 px-4 text-white font-mono">{pv.name}</td>
                  <td className="py-3 px-4 text-slate-200">{pv.status}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono">{pv.capacity}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono">{pv.storage_class || '-'}</td>
                  <td className="py-3 px-4 text-slate-200">{pv.reclaim_policy}</td>
                  <td className="py-3 px-4 text-slate-200">{(pv.access_modes || []).join(', ') || '-'}</td>
                  <td className="py-3 px-4 text-slate-200 font-mono">
                    {pv.claim_ref?.namespace && pv.claim_ref?.name ? `${pv.claim_ref.namespace}/${pv.claim_ref.name}` : '-'}
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td className="py-6 px-4 text-slate-400" colSpan={7}>
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
