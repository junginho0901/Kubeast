import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import NodeShellTerminal from '@/components/NodeShellTerminal'
import { usePermission } from '@/hooks/usePermission'
import type { useNodeData } from './useNodeData'

type NodeData = ReturnType<typeof useNodeData>

interface NodeActionsProps {
  name: string
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
  data: NodeData
}

export default function NodeActions({ name, tr, data }: NodeActionsProps) {
  const { has } = usePermission()
  const {
    nodeDescribe,
    cordonMut,
    uncordonMut,
    drainMut,
    isSchedulingMut,
    isDrainMut,
    drainDialogOpen,
    setDrainDialogOpen,
    drainStatus,
    setDrainStatus,
    drainError,
    setDrainError,
    drainId,
    showNodeShell,
    setShowNodeShell,
    nodeShellSettings,
    isLinuxNode,
  } = data

  const showDrainStatus = drainStatus !== 'idle' || !!drainId || !!drainError
  const drainMeta = drainStatus === 'success'
    ? { icon: CheckCircle2, label: 'Completed', tone: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' }
    : drainStatus === 'error'
    ? { icon: AlertTriangle, label: 'Failed', tone: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' }
    : drainStatus === 'draining'
    ? { icon: Loader2, label: 'Draining', tone: 'text-sky-300', bg: 'bg-sky-500/10', border: 'border-sky-500/20' }
    : { icon: Clock, label: 'Queued', tone: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/20' }

  return (
    <>
      {/* Action Buttons */}
      {(has('resource.node.cordon') || has('resource.node.drain') || has('resource.node.shell')) && (
        <div className="flex flex-wrap gap-2">
          {has('resource.node.cordon') && (
            <button
              onClick={() => nodeDescribe.unschedulable ? uncordonMut.mutate(name) : cordonMut.mutate(name)}
              disabled={isSchedulingMut || isDrainMut}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {isSchedulingMut ? (nodeDescribe.unschedulable ? tr('nodes.actions.uncordoning', 'Uncordoning...') : tr('nodes.actions.cordoning', 'Cordoning...'))
                : (nodeDescribe.unschedulable ? tr('nodes.actions.uncordon', 'Uncordon') : tr('nodes.actions.cordon', 'Cordon'))}
            </button>
          )}
          {has('resource.node.drain') && (
            <button
              onClick={() => { setDrainDialogOpen(true); setDrainError(null) }}
              disabled={isDrainMut || isSchedulingMut}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {isDrainMut ? tr('nodes.actions.draining', 'Draining...') : tr('nodes.actions.drain', 'Drain')}
            </button>
          )}
          {has('resource.node.shell') && nodeShellSettings.isEnabled && (
            <button
              onClick={() => setShowNodeShell(true)}
              disabled={!isLinuxNode}
              title={isLinuxNode ? undefined : 'Linux only'}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {tr('nodes.actions.debug', 'Debug')}
            </button>
          )}
        </div>
      )}

      {/* Drain Status Banner */}
      {showDrainStatus && (
        <div className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${drainMeta.bg} ${drainMeta.border}`}>
          <drainMeta.icon className={`w-4 h-4 mt-0.5 ${drainMeta.tone} ${drainStatus === 'draining' ? 'animate-spin' : ''}`} />
          <div className="flex-1">
            <span className={`text-xs font-semibold ${drainMeta.tone}`}>Drain: {drainMeta.label}</span>
            {drainError && <div className="mt-1 text-xs text-red-300">{drainError}</div>}
          </div>
        </div>
      )}

      {/* Drain Confirm Dialog */}
      {drainDialogOpen && (
        <ModalOverlay onClose={() => setDrainDialogOpen(false)}>
          <div className="bg-slate-800 rounded-lg w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-white mb-4">{tr('nodes.drain.title', 'Drain node')}</h2>
            <p className="text-slate-300">{tr('nodes.drain.confirm', 'Are you sure you want to drain node {{name}}?', { name })}</p>
            <p className="text-slate-400 mt-3">{tr('nodes.drain.warning', 'Draining will evict pods from this node.')}</p>
            {drainError && <div className="mt-4 text-sm text-red-400">{drainError}</div>}
            <div className="mt-6 flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setDrainDialogOpen(false)}>Cancel</button>
              <button
                className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                onClick={() => { setDrainStatus('pending'); setDrainDialogOpen(false); drainMut.mutate(name) }}
                disabled={isDrainMut}
              >Drain</button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Node Shell */}
      {showNodeShell && (
        <ModalOverlay onClose={() => setShowNodeShell(false)}>
          <div className="w-full max-w-5xl h-[80vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <NodeShellTerminal
              nodeName={name}
              namespace={nodeShellSettings.namespace}
              image={nodeShellSettings.linuxImage}
              onClose={() => setShowNodeShell(false)}
            />
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
