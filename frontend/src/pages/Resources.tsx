import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { 
  Server, 
  Box, 
  Database, 
  RefreshCw
} from 'lucide-react'

type ResourceType = 'services' | 'deployments' | 'pods' | 'pvcs'

export default function Resources() {
  const { namespace } = useParams<{ namespace: string }>()
  const [activeTab, setActiveTab] = useState<ResourceType>('deployments')

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

  const { data: pods } = useQuery({
    queryKey: ['pods', namespace],
    queryFn: () => api.getPods(namespace!),
    enabled: !!namespace && activeTab === 'pods',
  })

  const { data: pvcs } = useQuery({
    queryKey: ['pvcs', namespace],
    queryFn: () => api.getPVCs(namespace),
    enabled: activeTab === 'pvcs',
  })

  const tabs = [
    { id: 'deployments' as ResourceType, name: 'Deployments', icon: Server },
    { id: 'services' as ResourceType, name: 'Services', icon: Database },
    { id: 'pods' as ResourceType, name: 'Pods', icon: Box },
    { id: 'pvcs' as ResourceType, name: 'PVCs', icon: Database },
  ]

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase()
    if (statusLower.includes('running') || statusLower.includes('healthy') || statusLower.includes('active')) {
      return 'badge-success'
    }
    if (statusLower.includes('pending') || statusLower.includes('degraded')) {
      return 'badge-warning'
    }
    if (statusLower.includes('failed') || statusLower.includes('unavailable')) {
      return 'badge-error'
    }
    return 'badge-info'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">
            {namespace} 리소스
          </h1>
          <p className="mt-2 text-slate-400">
            네임스페이스의 모든 리소스를 확인하고 관리하세요
          </p>
        </div>
        <button className="btn btn-primary flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          새로고침
        </button>
      </div>

      {/* Tabs */}
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

      {/* Deployments */}
      {activeTab === 'deployments' && (
        <div className="space-y-4">
          {deployments?.map((deploy) => (
            <div key={deploy.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{deploy.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">{deploy.image}</p>
                </div>
                <span className={`badge ${getStatusColor(deploy.status)}`}>
                  {deploy.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Replicas</p>
                  <p className="text-lg font-bold text-white">{deploy.replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Ready</p>
                  <p className="text-lg font-bold text-white">{deploy.ready_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Available</p>
                  <p className="text-lg font-bold text-white">{deploy.available_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Updated</p>
                  <p className="text-lg font-bold text-white">{deploy.updated_replicas}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Services */}
      {activeTab === 'services' && (
        <div className="space-y-4">
          {services?.map((svc) => (
            <div key={svc.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{svc.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">Type: {svc.type}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Cluster IP</p>
                  <p className="text-sm font-mono text-white">{svc.cluster_ip || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">External IP</p>
                  <p className="text-sm font-mono text-white">{svc.external_ip || 'N/A'}</p>
                </div>
              </div>
              {svc.ports && svc.ports.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-2">Ports</p>
                  <div className="flex flex-wrap gap-2">
                    {svc.ports.map((port, idx) => (
                      <span key={idx} className="badge badge-info">
                        {port.port}:{port.target_port}/{port.protocol}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pods */}
      {activeTab === 'pods' && (
        <div className="space-y-4">
          {pods?.map((pod) => (
            <div key={pod.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{pod.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">Node: {pod.node_name || 'N/A'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`badge ${getStatusColor(pod.status)}`}>
                    {pod.status}
                  </span>
                  {pod.restart_count > 0 && (
                    <span className="badge badge-warning">
                      재시작: {pod.restart_count}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Phase</p>
                  <p className="text-sm text-white">{pod.phase}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">IP</p>
                  <p className="text-sm font-mono text-white">{pod.pod_ip || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Ready</p>
                  <p className="text-sm text-white">{pod.ready}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PVCs */}
      {activeTab === 'pvcs' && (
        <div className="space-y-4">
          {pvcs?.map((pvc) => (
            <div key={`${pvc.namespace}-${pvc.name}`} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{pvc.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">
                    Namespace: {pvc.namespace}
                  </p>
                </div>
                <span className={`badge ${getStatusColor(pvc.status)}`}>
                  {pvc.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Capacity</p>
                  <p className="text-sm text-white">{pvc.capacity || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Storage Class</p>
                  <p className="text-sm text-white">{pvc.storage_class || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Volume</p>
                  <p className="text-sm font-mono text-white">{pvc.volume_name || 'N/A'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
