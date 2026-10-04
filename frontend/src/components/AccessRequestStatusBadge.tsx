import { useTranslation } from 'react-i18next'

import type { AccessRequest } from '@/services/api/access_requests'

const STATUS_CLASS: Record<AccessRequest['status'], string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-700/50',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-700/50',
  rejected: 'bg-red-500/15 text-red-300 border-red-800/50',
  cancelled: 'bg-slate-500/15 text-slate-300 border-slate-600/50',
  expired: 'bg-slate-500/15 text-slate-400 border-slate-600/50',
}

// Status pill for an access request; an ended request also says why.
export default function AccessRequestStatusBadge({ request }: { request: AccessRequest }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const label = tr(`accessRequests.status.${request.status}`, request.status)
  const reason = request.end_reason ? tr(`accessRequests.endReason.${request.end_reason}`, request.end_reason) : ''
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[request.status] ?? STATUS_CLASS.expired}`}
      data-testid={`access-request-status-${request.id}`}
      title={reason}
    >
      {label}
      {reason && <span className="text-[10px] opacity-75">· {reason}</span>}
    </span>
  )
}
