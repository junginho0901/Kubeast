import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { Box, ArrowRight, Network, RefreshCw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useState } from 'react'

export default function Namespaces() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  const { data: namespaces, isLoading } = useQuery({
    queryKey: ['namespaces'],
    queryFn: api.getNamespaces,
    staleTime: 30000, // 30초 동안 캐시 유지
  })
  
  const handleRefresh = async () => {
    setIsRefreshing(true)
    await queryClient.invalidateQueries({ queryKey: ['namespaces'] })
    setTimeout(() => setIsRefreshing(false), 500)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse">
          <div className="h-10 bg-slate-700 rounded w-64 mb-2"></div>
          <div className="h-4 bg-slate-700 rounded w-96"></div>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 animate-pulse">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card">
              <div className="h-48 bg-slate-700 rounded"></div>
            </div>
          ))}
        </div>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {namespaces?.map((ns) => (
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

            <div className="mt-6 grid grid-cols-3 gap-4">
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
        ))}
      </div>
    </div>
  )
}
