// Resource list modal — opened when a stat card on the Dashboard is
// clicked (Namespaces / Pods / Services / Deployments / PVCs / Nodes).
// Each branch renders a different list shape; the parent prepares the
// filtered list for the current resource type and passes it as
// `filteredResources`.

import { useTranslation } from 'react-i18next'
import { Box, CheckCircle, RefreshCw, Search, X, XCircle } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import type { ResourceType } from '../types'

interface SelectedStat {
  name: string
  icon: any
  color?: string
  bgColor?: string
}

interface Props {
  selectedResourceType: ResourceType | null
  onClose: () => void
  selectedStat: SelectedStat | undefined
  isLoading: boolean
  resourceCount: number
  searchQuery: string
  setSearchQuery: (q: string) => void
  filteredResources: any[]
}

export function ResourceModal({
  selectedResourceType,
  onClose,
  selectedStat,
  isLoading,
  resourceCount,
  searchQuery,
  setSearchQuery,
  filteredResources,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const na = tr('common.notAvailable', 'N/A')
  const none = tr('common.none', 'None')
  const { open: openDetail } = useResourceDetail()

  if (!selectedResourceType) return null

  const Icon = selectedStat?.icon || Box

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 모달 헤더 */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {selectedStat && (
                <div className={`p-2 rounded-lg ${selectedStat.bgColor || 'bg-slate-700'}`}>
                  <Icon className={`w-5 h-5 ${selectedStat.color || 'text-white'}`} />
                </div>
              )}
              <div>
                <h2 className="text-xl font-bold text-white">
                  {selectedStat?.name || selectedResourceType}
                </h2>
                <p className="text-sm text-slate-400">
                  {isLoading
                    ? tr('dashboard.resourceModal.loading', 'Loading...')
                    : tr('dashboard.resourceModal.total', 'Total {{count}}', { count: resourceCount })}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>
          {/* 검색창 - 헤더 내부 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('dashboard.resourceModal.searchPlaceholder', 'Search...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded-sm transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            )}
          </div>
        </div>

        {/* 모달 내용 */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
              <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
              <p className="text-slate-400">{tr('dashboard.loading', 'Loading data...')}</p>
            </div>
          ) : (
            <>
              {selectedResourceType === 'namespaces' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((ns) => (
                      <div
                        key={ns.name}
                        onClick={() => openDetail({ kind: 'Namespace', name: ns.name })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-white">{ns.name}</h3>
                            <p className="text-sm text-slate-400 mt-1">
                              {tr('dashboard.resourceModal.namespaceSummary', 'Pods: {{pods}} | Services: {{services}} | Deployments: {{deployments}}', {
                                pods: ns.resource_count?.pods || 0,
                                services: ns.resource_count?.services || 0,
                                deployments: ns.resource_count?.deployments || 0,
                              })}
                            </p>
                          </div>
                          <span className={`badge ${ns.status === 'Active' ? 'badge-success' : 'badge-warning'
                            }`}>
                            {ns.status}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noNamespaces', 'No namespaces')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {selectedResourceType === 'pods' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((pod) => (
                      <div
                        key={`${pod.namespace}-${pod.name}`}
                        onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {pod.phase === 'Running' ? (
                              <CheckCircle className="w-5 h-5 text-green-400" />
                            ) : (
                              <XCircle className="w-5 h-5 text-red-400" />
                            )}
                            <div>
                              <h3 className="font-medium text-white">{pod.name}</h3>
                              <p className="text-sm text-slate-400">{pod.namespace}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`badge ${pod.phase === 'Running' ? 'badge-success' : 'badge-warning'
                              }`}>
                              {pod.phase}
                            </span>
                            {pod.node_name && (
                              <span className="text-xs text-slate-400">{pod.node_name}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noPods', 'No pods')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {selectedResourceType === 'services' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((svc) => (
                      <div
                        key={`${svc.namespace}-${svc.name}`}
                        onClick={() => openDetail({ kind: 'Service', name: svc.name, namespace: svc.namespace })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-white">{svc.name}</h3>
                            <p className="text-sm text-slate-400 mt-1">
                              {svc.namespace} | {tr('dashboard.resourceModal.typeLabel', 'Type')}: {svc.type} | {tr('dashboard.resourceModal.clusterIpLabel', 'Cluster IP')}: {svc.cluster_ip || none}
                            </p>
                          </div>
                          <span className="badge badge-info">{svc.type}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noServices', 'No services')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {selectedResourceType === 'deployments' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((deploy) => (
                      <div
                        key={`${deploy.namespace}-${deploy.name}`}
                        onClick={() => openDetail({ kind: 'Deployment', name: deploy.name, namespace: deploy.namespace })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-white">{deploy.name}</h3>
                            <p className="text-sm text-slate-400 mt-1">
                              {deploy.namespace} | {tr('dashboard.resourceModal.replicasLabel', 'Replicas')}: {deploy.ready_replicas}/{deploy.replicas}
                            </p>
                          </div>
                          <span className={`badge ${deploy.ready_replicas === deploy.replicas ? 'badge-success' : 'badge-warning'
                            }`}>
                            {deploy.status}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noDeployments', 'No deployments')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {selectedResourceType === 'pvcs' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((pvc) => (
                      <div
                        key={`${pvc.namespace}-${pvc.name}`}
                        onClick={() => openDetail({ kind: 'PersistentVolumeClaim', name: pvc.name, namespace: pvc.namespace })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-white">{pvc.name}</h3>
                            <p className="text-sm text-slate-400 mt-1">
                              {pvc.namespace} | {pvc.capacity || na} | {pvc.storage_class || na}
                            </p>
                          </div>
                          <span className={`badge ${pvc.status === 'Bound' ? 'badge-success' : 'badge-warning'
                            }`}>
                            {pvc.status}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noPVCs', 'No PVCs')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {selectedResourceType === 'nodes' && (
                <div className="space-y-2">
                  {filteredResources.length > 0 ? (
                    filteredResources.map((node) => (
                      <div
                        key={node.name}
                        onClick={() => openDetail({ kind: 'Node', name: node.name })}
                        className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-white">{node.name}</h3>
                            <p className="text-sm text-slate-400 mt-1">
                              {tr('dashboard.resourceModal.versionLabel', 'Version')}: {node.version || na} |
                              {tr('dashboard.resourceModal.internalIpLabel', 'Internal IP')}: {node.internal_ip || na}
                              {node.roles && node.roles.length > 0 && ` | ${tr('dashboard.resourceModal.rolesLabel', 'Roles')}: ${node.roles.join(', ')}`}
                            </p>
                          </div>
                          <span className={`badge ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                            }`}>
                            {node.status}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {searchQuery
                          ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                          : tr('dashboard.resourceModal.noNodes', 'No nodes')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
