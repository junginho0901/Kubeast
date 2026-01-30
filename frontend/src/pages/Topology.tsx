import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { FileCode, Package, Network as NetworkIcon, Database, Key, Box, Clock, Globe, FileBox, HardDrive } from 'lucide-react'
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism'

type ResourceType = 
  | 'deployment' 
  | 'service' 
  | 'pod' 
  | 'configmap' 
  | 'secret' 
  | 'statefulset' 
  | 'daemonset' 
  | 'ingress' 
  | 'job' 
  | 'cronjob'
  | 'pvc'

interface ResourceCategory {
  type: ResourceType
  label: string
  icon: React.ReactNode
  endpoint: string
}

const resourceCategories: ResourceCategory[] = [
  { type: 'deployment', label: 'Deployments', icon: <Package className="w-4 h-4" />, endpoint: 'deployments' },
  { type: 'service', label: 'Services', icon: <NetworkIcon className="w-4 h-4" />, endpoint: 'services' },
  { type: 'pod', label: 'Pods', icon: <Box className="w-4 h-4" />, endpoint: 'pods' },
  { type: 'statefulset', label: 'StatefulSets', icon: <Database className="w-4 h-4" />, endpoint: 'statefulsets' },
  { type: 'daemonset', label: 'DaemonSets', icon: <HardDrive className="w-4 h-4" />, endpoint: 'daemonsets' },
  { type: 'configmap', label: 'ConfigMaps', icon: <FileBox className="w-4 h-4" />, endpoint: 'configmaps' },
  { type: 'secret', label: 'Secrets', icon: <Key className="w-4 h-4" />, endpoint: 'secrets' },
  { type: 'ingress', label: 'Ingresses', icon: <Globe className="w-4 h-4" />, endpoint: 'ingresses' },
  { type: 'job', label: 'Jobs', icon: <Clock className="w-4 h-4" />, endpoint: 'jobs' },
  { type: 'cronjob', label: 'CronJobs', icon: <Clock className="w-4 h-4" />, endpoint: 'cronjobs' },
  { type: 'pvc', label: 'PVCs', icon: <Database className="w-4 h-4" />, endpoint: 'pvcs' },
]

export default function Topology() {
  const { namespace } = useParams<{ namespace: string }>()
  const [selectedType, setSelectedType] = useState<ResourceType>('deployment')
  const [selectedResource, setSelectedResource] = useState<string | null>(null)

  // 리소스 목록 조회
  const { data: resources, isLoading: resourcesLoading, refetch: refetchResources } = useQuery({
    queryKey: ['resources', selectedType, namespace],
    queryFn: async () => {
      if (!namespace) return []
      const category = resourceCategories.find(c => c.type === selectedType)
      if (!category) return []
      
      const response = await fetch(
        `http://localhost:8000/api/v1/cluster/namespaces/${namespace}/${category.endpoint}`
      )
      return response.json()
    },
    enabled: !!namespace,
  })

  // YAML 조회
  const { data: yaml, isLoading: yamlLoading, error: yamlError, refetch: refetchYaml } = useQuery({
    queryKey: ['yaml', selectedType, namespace, selectedResource],
    queryFn: async () => {
      if (!namespace || !selectedResource) return null
      const category = resourceCategories.find(c => c.type === selectedType)
      if (!category) return null
      
      try {
        const response = await fetch(
          `http://localhost:8000/api/v1/cluster/namespaces/${namespace}/${category.endpoint}/${selectedResource}/yaml`
        )
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          // 콘솔에 일반 로그로만 출력
          console.log(`ℹ️ 리소스를 찾을 수 없습니다: ${selectedType}/${selectedResource} (${namespace})`)
          throw new Error(errorData.detail || `리소스를 찾을 수 없습니다`)
        }
        
        const data = await response.json()
        return data.yaml
      } catch (error) {
        // fetch 에러를 잡아서 일반 로그로만 출력
        if (error instanceof Error && error.message !== '리소스를 찾을 수 없습니다') {
          console.log(`ℹ️ YAML 조회 실패: ${selectedType}/${selectedResource}`)
        }
        throw error
      }
    },
    enabled: !!namespace && !!selectedResource,
    staleTime: 0, // 데이터를 항상 stale로 간주
    gcTime: 0, // 캐시 비활성화 (항상 새로 가져오기)
    retry: false, // 에러 시 재시도하지 않음
  })

  if (!namespace) {
    return (
      <div className="text-center py-12">
        <FileCode className="w-16 h-16 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-400">네임스페이스를 선택하세요</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 h-full">
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <FileCode className="w-8 h-8" />
          {namespace} 리소스 정의
        </h1>
        <p className="mt-2 text-slate-400">
          모든 Kubernetes 리소스의 YAML 정의를 확인하세요
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-220px)]">
        {/* 리소스 타입 선택 */}
        <div className="card h-full flex flex-col overflow-hidden">
          <h2 className="text-lg font-semibold text-white mb-4">리소스 타입</h2>
          <div className="space-y-2 flex-1 min-h-0 overflow-y-auto">
            {resourceCategories.map((category) => (
              <button
                key={category.type}
                onClick={() => {
                  setSelectedType(category.type)
                  setSelectedResource(null)
                }}
                className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                  selectedType === category.type
                    ? 'bg-primary-600 text-white'
                    : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                }`}
              >
                {category.icon}
                {category.label}
              </button>
            ))}
          </div>
        </div>

        {/* 리소스 목록 */}
        <div className="card h-full flex flex-col overflow-hidden">
          <h2 className="text-lg font-semibold text-white mb-4">
            {resourceCategories.find(c => c.type === selectedType)?.label}
          </h2>
          {resourcesLoading ? (
            <div className="flex-1 min-h-0 flex items-center justify-center text-slate-400">
              로딩 중...
            </div>
          ) : (
            <div className="space-y-2 flex-1 min-h-0 overflow-y-auto">
              {resources && resources.length > 0 ? (
                resources.map((resource: any) => (
                  <button
                    key={resource.name}
                    onClick={() => setSelectedResource(resource.name)}
                    className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                      selectedResource === resource.name
                        ? 'bg-primary-600 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                    }`}
                  >
                    <div className="font-medium">{resource.name}</div>
                    {resource.status && (
                      <div className="text-xs opacity-75">{resource.status}</div>
                    )}
                  </button>
                ))
              ) : (
                <div className="text-slate-400 text-sm">리소스가 없습니다</div>
              )}
            </div>
          )}
        </div>

        {/* YAML 내용 */}
        <div className="card lg:col-span-2 h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              {selectedResource ? `${selectedResource} YAML` : 'YAML 내용'}
            </h2>
            {selectedResource && (
              <button
                onClick={() => {
                  refetchYaml()
                }}
                className="btn btn-secondary text-sm"
                title="YAML 새로고침"
              >
                새로고침
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {yamlLoading ? (
              <div className="flex items-center justify-center h-full text-slate-400">
                YAML 로딩 중...
              </div>
            ) : yamlError ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-6">
                <div className="text-red-400 mb-4">
                  ❌ YAML을 가져올 수 없습니다
                </div>
                <p className="text-slate-400 text-sm mb-4">
                  {(yamlError as Error).message.includes('not found') 
                    ? '리소스가 삭제되었거나 존재하지 않습니다.'
                    : (yamlError as Error).message}
                </p>
                <button
                  onClick={() => {
                    refetchResources()
                    setSelectedResource(null)
                  }}
                  className="btn btn-primary"
                >
                  목록 새로고침
                </button>
              </div>
            ) : yaml ? (
              <div className="bg-slate-900 rounded-lg overflow-auto h-full">
                <SyntaxHighlighter 
                  language="yaml" 
                  style={dracula} 
                  customStyle={{ 
                    padding: '1rem',
                    margin: 0,
                    fontSize: '0.875rem',
                    height: '100%',
                  }}
                >
                  {String(yaml)}
                </SyntaxHighlighter>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 text-center">
                <FileCode className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>리소스를 선택하면 YAML 정의를 볼 수 있습니다</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
