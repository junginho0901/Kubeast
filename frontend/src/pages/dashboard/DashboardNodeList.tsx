// Dashboard "Nodes" card — compact grid of node cards (status icon /
// name / version / roles / IP / status badge). Click a card to open
// the node detail drawer (handled by the parent). Nodes that are not Ready
// come first and the card shows at most SHOWN; the Nodes page lists them all.

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Info, XCircle } from 'lucide-react'

const SHOWN = 8

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
  const shown = [...nodes].sort((a, b) => Number(a.status === 'Ready') - Number(b.status === 'Ready')).slice(0, SHOWN)

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-lg font-semibold text-ink">{tr('dashboard.nodes.title', 'Nodes')}</h2>
        {nodes.length > SHOWN && (
          <Link to="/cluster/nodes" data-testid="dashboard-nodes-all" className="text-sm text-primary-400 hover:text-primary-300">
            {tr('dashboard.nodes.viewAll', 'View all {{count}} nodes', { count: nodes.length })}
          </Link>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
        {shown.map((node) => (
          <button
            key={node.name}
            onClick={() => onNodeClick(node)}
            className="p-3 border border-slate-700 rounded-md hover:bg-slate-700/50 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-start gap-2 mb-2">
              {node.status === 'Ready' ? (
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink truncate" title={node.name}>
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
