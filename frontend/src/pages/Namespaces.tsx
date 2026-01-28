import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { Box, ArrowRight, Network, RefreshCw, Search } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useState, useMemo } from 'react'

export default function Namespaces() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  
  const { data: namespaces, isLoading } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
  })
  
  // 검색어로 네임스페이스 필터링
  const filteredNamespaces = useMemo(() => {
    if (!namespaces) return []
    if (!searchQuery.trim()) return namespaces
    return namespaces.filter(ns => 
      ns.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [namespaces, searchQuery])
  
  const handleRefresh = async () => {
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신
    try {
      const namespacesData = await api.getNamespaces(true)
      
      // 캐시 제거 후 새 데이터로 업데이트
      queryClient.removeQueries({ queryKey: ['namespaces'] })
      queryClient.setQueryData(['namespaces'], namespacesData)
    } catch (error) {
      console.error('새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
        <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
        <p className="text-slate-400">데이터를 불러오는 중...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">네임스페이스</h1>
          <p className="mt-2 text-slate-400">
            클러스터의 모든 네임스페이스를 확인하고 리소스를 관리하세요
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      {/* 검색창 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder="네임스페이스 검색..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {/* 검색 결과 개수 표시 */}
      {searchQuery && (
        <p className="text-sm text-slate-400">
          {filteredNamespaces.length}개의 네임스페이스가 검색되었습니다
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {filteredNamespaces.length > 0 ? (
          filteredNamespaces.map((ns) => (
          <div key={ns.name} className="card hover:border-primary-500 transition-colors cursor-pointer">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-primary-500/10 rounded-lg">
                  <Box className="w-6 h-6 text-primary-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">{ns.name}</h3>
                  <p className="text-sm text-slate-400">
                    생성: {formatDistanceToNow(new Date(ns.created_at), { 
                      addSuffix: true, 
                      locale: ko 
                    })}
                  </p>
                </div>
              </div>
              <span className={`badge ${
                ns.status === 'Active' ? 'badge-success' : 'badge-warning'
              }`}>
                {ns.status}
              </span>
            </div>

            <div className="mt-6 grid grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-slate-400">Pods</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.pods || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">Services</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.services || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">Deployments</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.deployments || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">PVCs</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.pvcs || 0}
                </p>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => navigate(`/resources/${ns.name}`)}
                className="btn btn-primary flex-1 flex items-center justify-center gap-2"
              >
                리소스 보기
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => navigate(`/topology/${ns.name}`)}
                className="btn btn-secondary flex items-center justify-center gap-2"
              >
                <Network className="w-4 h-4" />
                YAML 보기
              </button>
            </div>
          </div>
          ))
        ) : (
          <div className="col-span-full text-center py-12">
            <p className="text-slate-400">
              {searchQuery ? '검색 결과가 없습니다' : '네임스페이스가 없습니다'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
