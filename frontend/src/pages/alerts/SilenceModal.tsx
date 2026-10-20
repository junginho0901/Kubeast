import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { BellOff, Plus, X } from 'lucide-react'

import { api } from '@/services/api'
import type { SilenceMatcher } from '@/services/api/alertInbox'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import CustomDropdown from '@/components/CustomDropdown'

// A silence in the cluster's alert store (features.alertStore.silences, resource.alert.silence): label conditions,
// how long, why. The server adds the cluster's own condition, so the conditions here never need it; what the silence
// would mute now is shown before it is made. Making it is audited server-side (alert.silence.create).

type Op = '=' | '!=' | '=~' | '!~'
interface Row { name: string; op: Op; value: string }

const OPS: Op[] = ['=', '!=', '=~', '!~']
const HOURS = [1, 4, 24, 72, 168]

function toMatcher(r: Row): SilenceMatcher {
  return { name: r.name.trim(), value: r.value, isRegex: r.op === '=~' || r.op === '!~', isEqual: r.op === '=' || r.op === '=~' }
}

export default function SilenceModal({ initial, maxHours, onClose }: {
  initial: Record<string, string>
  maxHours: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<Row[]>(() => Object.entries(initial).map(([name, value]) => ({ name, op: '=' as Op, value })))
  const hours = HOURS.filter((h) => h <= maxHours)
  const [duration, setDuration] = useState(String(hours.includes(4) ? 4 : hours[0] ?? 1))
  const [comment, setComment] = useState('')
  const matchers = useMemo(() => rows.filter((r) => r.name.trim()).map(toMatcher), [rows])
  const [asked, setAsked] = useState(matchers)
  // ask for the preview once the conditions have stopped changing for a moment
  useEffect(() => {
    const id = setTimeout(() => setAsked(matchers), 400)
    return () => clearTimeout(id)
  }, [matchers])

  const preview = useQuery({
    queryKey: ['alert-inbox', 'silence-preview', asked],
    queryFn: () => api.previewAlertSilence(asked),
    enabled: asked.length > 0,
    retry: false,
  })
  const create = useMutation({
    mutationFn: () => api.createAlertSilence({ matchers, durationMinutes: Number(duration) * 60, comment: comment.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-inbox'] })
      onClose()
    },
  })
  const serverMessage = (e: unknown) => (e as { response?: { data?: { detail?: string } } })?.response?.data
  const previewError = preview.error ? serverMessage(preview.error) : null
  const createError = create.error ? serverMessage(create.error) : null
  const set = (i: number, patch: Partial<Row>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <ModalFrame
      title={tr('alertInbox.silence.title', 'Silence alerts')}
      subtitle={tr('alertInbox.silence.subtitle', 'In the alert store for this cluster: alerts matching every condition are not sent while the silence lasts.')}
      icon={<BellOff className="w-5 h-5 text-primary-400" />}
      size="lg"
      body="scroll"
      onClose={onClose}
      busy={create.isPending}
      testId="silence-modal"
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.cancel}>{tr('common.cancel', 'Cancel')}</button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || matchers.length === 0 || !comment.trim()}
            className={modalButton.primary}
            data-testid="silence-create"
          >
            {tr('alertInbox.silence.create', 'Silence')}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('alertInbox.silence.conditions', 'Label conditions')}</h3>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2" data-testid="silence-matcher">
                <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="label"
                  className="h-10 w-44 rounded-lg border border-slate-700 bg-slate-950/60 px-3 font-mono text-sm text-white" aria-label={tr('alertInbox.silence.label', 'Label')} />
                <select value={r.op} onChange={(e) => set(i, { op: e.target.value as Op })}
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-2 font-mono text-sm text-white" aria-label={tr('alertInbox.silence.operator', 'Operator')}>
                  {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
                <input value={r.value} onChange={(e) => set(i, { value: e.target.value })}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950/60 px-3 font-mono text-sm text-white" aria-label={tr('alertInbox.silence.value', 'Value')} />
                <button type="button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))} className="rounded-sm p-1.5 text-slate-400 hover:text-white"
                  aria-label={tr('alertInbox.silence.remove', 'Remove condition')}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setRows((all) => [...all, { name: '', op: '=', value: '' }])} className="inline-flex items-center gap-1 text-xs text-primary-300 hover:underline">
              <Plus className="w-3.5 h-3.5" /> {tr('alertInbox.silence.add', 'Add a condition')}
            </button>
            <p className="text-xs text-slate-500">{tr('alertInbox.silence.clusterNote', 'The condition for this cluster is added when it is made.')}</p>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-[180px_1fr]">
          <CustomDropdown
            label={tr('alertInbox.silence.duration', 'Duration')}
            value={duration}
            onChange={setDuration}
            options={hours.map((h) => ({ value: String(h), label: h < 24 ? tr('alertInbox.silence.hours', '{{n}} h', { n: h }) : tr('alertInbox.silence.days', '{{n}} d', { n: h / 24 }) }))}
          />
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1" htmlFor="silence-comment">{tr('alertInbox.silence.comment', 'Why (required)')}</label>
            <input id="silence-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-white" data-testid="silence-comment" />
          </div>
        </div>

        <section data-testid="silence-preview">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{tr('alertInbox.silence.affected', 'Alerts it would mute now')}</h3>
          {previewError ? (
            <p className="text-sm text-amber-300">{previewError.detail || tr('alertInbox.silence.previewFailed', 'The conditions could not be checked.')}</p>
          ) : preview.data ? (
            <>
              <p className="mb-2 text-sm text-slate-200" data-testid="silence-preview-count">
                {tr('alertInbox.silence.affectedCount', '{{count}} alert(s)', { count: preview.data.total })}
              </p>
              <ul className="space-y-1 text-xs">
                {preview.data.alerts.slice(0, 10).map((a) => (
                  <li key={a.fingerprint} className="flex gap-2 text-slate-300"><span className="font-mono text-slate-100">{a.alertname}</span><span className="text-slate-500">{a.labels.namespace ?? ''}</span><span>{a.state}</span></li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-500">-</p>
          )}
        </section>

        {createError && (
          <div className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-200" data-testid="silence-error">
            {createError.detail || tr('alertInbox.silence.failed', 'The silence was not made.')}
          </div>
        )}
      </div>
    </ModalFrame>
  )
}
