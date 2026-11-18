// Dashboard "Nodes" card — compact information rows (status icon /
// name / version / roles / IP / status badges as the Nodes list draws them).
// Click a card to open the node detail drawer (handled by the parent). Nodes
// that are not Ready come first, then cordoned ones, and the card shows at
// most SHOWN; the Nodes page lists them all.

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Info, XCircle } from 'lucide-react'

import { nodeCordoned, nodeReadiness, nodeStatusBadge, nodeStatusParts } from '@/utils/nodeStatus'

const SHOWN = 8

const attention = (status?: string) => (nodeReadiness(status) !== 'Ready' ? 0 : nodeCordoned(status) ? 1 : 2)

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
  const shown = [...nodes].sort((a, b) => attention(a.status) - attention(b.status)).slice(0, SHOWN)

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
      <div className="divide-y divide-hairline max-h-[400px] overflow-y-auto">
        {shown.map((node) => (
          <button
            key={node.name}
            onClick={() => onNodeClick(node)}
            className="grid w-full grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.8fr)_auto] items-center gap-x-6 gap-y-2 p-3 hover:bg-slate-700/50 transition-colors text-left cursor-pointer min-w-0"
          >
            <div className="flex items-start gap-2 min-w-0">
              {nodeReadiness(node.status) === 'Ready' ? (
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 min-w-0 [&>p]:min-w-0 [&>p]:[overflow-wrap:anywhere]">
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
            <div className="flex flex-wrap gap-y-1" data-testid="dashboard-node-status">
              {nodeStatusParts(node.status).map((part) => (
                <span key={part} className={`badge text-xs mr-1 last:mr-0 ${nodeStatusBadge(part)}`}>{part}</span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
