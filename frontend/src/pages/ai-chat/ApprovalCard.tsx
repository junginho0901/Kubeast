import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { aiApi, type ToolApproval } from '@/services/api/ai'

// H2: a write tool the model asked for is executed only after the user
// approves it here. The card shows exactly what will run (tool, cluster,
// arguments) and the outcome afterwards; status comes from the server so a
// reloaded session shows the truth.

interface Props {
  approvalId: string
  tool: string
  args?: Record<string, unknown>
  cluster?: string
  initialStatus?: ToolApproval['status']
}

const statusStyles: Record<ToolApproval['status'], string> = {
  pending: 'border-amber-500/40 bg-amber-500/10',
  approved: 'border-sky-500/40 bg-sky-500/10',
  executed: 'border-emerald-500/40 bg-emerald-500/10',
  failed: 'border-red-500/40 bg-red-500/10',
  rejected: 'border-slate-600 bg-slate-800/60',
  expired: 'border-slate-600 bg-slate-800/60',
}

export function ApprovalCard({ approvalId, tool, args, cluster, initialStatus }: Props) {
  const { t } = useTranslation()
  const [approval, setApproval] = useState<ToolApproval | null>(null)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    aiApi
      .getToolApproval(approvalId)
      .then((a) => {
        if (!cancelled) setApproval(a)
      })
      .catch(() => {
        /* keep the initial status; the card still shows what was asked */
      })
    return () => {
      cancelled = true
    }
  }, [approvalId])

  const status: ToolApproval['status'] = approval?.status ?? initialStatus ?? 'pending'
  const shownArgs = approval?.args ?? args ?? {}
  const shownCluster = approval?.cluster ?? cluster ?? ''

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind)
    setError(null)
    try {
      const next = kind === 'approve' ? await aiApi.approveToolCall(approvalId) : await aiApi.rejectToolCall(approvalId)
      setApproval(next)
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'request failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      data-testid="tool-approval-card"
      data-approval-status={status}
      className={`not-prose mt-3 rounded-lg border px-3 py-2 text-sm ${statusStyles[status]}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" />
        <span className="font-semibold">{t('aiChat.approval.title', 'This action changes the cluster')}</span>
        <span className="ml-auto rounded-full border border-slate-600 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-300">
          {t(`aiChat.approval.status.${status}`, status)}
        </span>
      </div>
      <div className="mt-1 text-xs text-slate-300">
        <code className="text-slate-100">{tool}</code>
        {shownCluster && (
          <>
            {' · '}
            {t('aiChat.approval.cluster', 'cluster')} <code className="text-slate-100">{shownCluster}</code>
          </>
        )}
      </div>
      {Object.keys(shownArgs).length > 0 && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-[11px] text-slate-200">
          {JSON.stringify(shownArgs, null, 2)}
        </pre>
      )}
      {status === 'pending' && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => decide('approve')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {t('aiChat.approval.approve', 'Approve and run')}
          </button>
          <button
            type="button"
            onClick={() => decide('reject')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded bg-slate-600 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-500 disabled:opacity-50"
          >
            {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            {t('aiChat.approval.reject', 'Reject')}
          </button>
          <span className="text-[11px] text-slate-400">{t('aiChat.approval.hint', 'Runs as you, with the arguments shown above.')}</span>
        </div>
      )}
      {(status === 'executed' || status === 'failed') && approval?.result && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950/60 p-2 text-[11px] text-slate-200">{approval.result}</pre>
      )}
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
    </div>
  )
}
