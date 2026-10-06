// Dashboard "Nodes" card — compact grid of node cards (status icon /
// name / version / roles / IP / status badge). Click a card to open
// the node detail drawer (handled by the parent).

import { useTranslation } from 'react-i18next'
import { CheckCircle, Info, XCircle } from 'lucide-react'

interface Props {
  nodes: any[]
  onNodeClick: (node: any) => void
}

export function DashboardNodeList({ nodes, onNodeClick }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const na = tr('common.notAvailable', 'N/A')

  if (!Array.isArray(nodes) || nodes.length === 0) return null

  return (
    <div className="card">
      <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.nodes.title', 'Nodes')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
        {nodes.map((node) => (
          <button
            key={node.name}
            onClick={() => onNodeClick(node)}
            className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-start gap-2 mb-2">
              {node.status === 'Ready' ? (
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate" title={node.name}>
                  {node.name}
                </p>
              </div>
              <Info className="w-4 h-4 text-slate-400 shrink-0" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-slate-400">
                <span className="font-medium">{tr('dashboard.nodeCard.versionLabel', 'Version')}:</span> {node.version || na}
              </p>
              {node.roles && node.roles.length > 0 && (
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.rolesLabel', 'Roles')}:</span> {node.roles.join(', ')}
                </p>
              )}
              {node.internal_ip && (
                <p className="text-xs text-slate-400">
                  <span className="font-medium">{tr('dashboard.nodeCard.ipLabel', 'IP')}:</span> {node.internal_ip}
                </p>
              )}
            </div>
            <div className="mt-2">
              <span className={`badge text-xs ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                }`}>
                {node.status}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
