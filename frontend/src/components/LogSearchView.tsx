// Log store search (chart features.logSearch), shared by the Pod drawer, the cluster view's
// Logs tab and the workload drawers. Lines stay searchable after their pod is gone. Every
// search is one audited read of the store, so it runs when the view opens and on Search /
// Load older, never while typing.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, History, Waypoints } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'
import { api } from '@/services/api'
import type { LogSearchLine } from '@/services/api/types'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { formatBytes, highlightParts, rangeOptions } from '@/utils/logSearch'
import { traceTemplates } from '@/utils/features'
import { fillTraceTemplate } from '@/utils/traceLinks'
import { absoluteTitle, formatTime } from '@/utils/time'

interface Props {
  namespace: string
  // One pod, or the pods a workload's controller makes.
  pod?: string
  workload?: { kind: string; name: string }
  container?: string
  size?: 'sm' | 'md'
  // Rendered first in the controls row (the container picker).
  leading?: ReactNode
}

interface Submitted {
  q: string
  regex: boolean
  ignoreCase: boolean
  start: string
  end: string
}

export function LogSearchView({ namespace, pod, workload, container, size = 'md', leading }: Props) {
  const { t } = useTranslation()
  const { currentCluster } = useCluster()
  const { data: features } = useClusterFeatures()
  const maxMinutes = features?.logSearch?.maxRangeMinutes || 1440
  const traceUrl = traceTemplates(features)?.traceUrl
  const traceHref = (l: LogSearchLine) =>
    l.traceId ? fillTraceTemplate(traceUrl, { traceId: l.traceId, cluster: currentCluster, namespace: l.namespace, pod: l.pod, container: l.container, service: l.service }) : null
  const ranges = rangeOptions(maxMinutes)
  const defaultRange = ranges.includes(features?.logSearch?.defaultRangeMinutes ?? 60) ? (features?.logSearch?.defaultRangeMinutes ?? 60) : ranges[0]

  const [text, setText] = useState('')
  const [regex, setRegex] = useState(false)
  const [ignoreCase, setIgnoreCase] = useState(true)
  const [minutes, setMinutes] = useState(defaultRange)
  const [submitted, setSubmitted] = useState<Submitted | null>(null)
  const [lines, setLines] = useState<LogSearchLine[]>([])
  const [truncated, setTruncated] = useState(false)
  const [oldest, setOldest] = useState<string | undefined>()
  const [bytes, setBytes] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const errorText = useCallback(
    (err: any): string => {
      const status: number | undefined = err?.response?.status
      const detail: string = err?.response?.data?.detail || err?.message || ''
      if (status === 429) return t('clusterView.logSearch.errors.tooMany', 'Too many searches in a minute. Try again shortly.')
      if (status === 403) return t('clusterView.logSearch.errors.forbidden', 'Not allowed: {{detail}}', { detail })
      if (status === 504) return t('clusterView.logSearch.errors.timeout', 'The log store did not answer in time. Narrow the range or the filters.')
      return t('clusterView.logSearch.errors.generic', 'Search failed: {{detail}}', { detail })
    },
    [t],
  )

  const run = useCallback(
    async (s: Submitted, older: string | undefined) => {
      const mine = ++seq.current
      setBusy(true)
      setError(null)
      try {
        const res = await api.searchLogs({
          namespace,
          pod,
          container: container || undefined,
          workload_kind: workload?.kind,
          workload_name: workload?.name,
          q: s.q || undefined,
          match: s.regex ? 'regex' : 'contains',
          ignore_case: s.ignoreCase,
          start: s.start,
          end: older ?? s.end,
        })
        if (mine !== seq.current) return
        setLines((prev) => (older ? [...prev, ...res.lines] : res.lines))
        setTruncated(res.truncated)
        setOldest(res.oldest)
        setBytes((prev) => (older ? prev + res.bytes : res.bytes))
      } catch (err) {
        if (mine === seq.current) setError(errorText(err))
      } finally {
        if (mine === seq.current) setBusy(false)
      }
    },
    [namespace, pod, container, workload?.kind, workload?.name, errorText],
  )

  const search = useCallback(() => {
    const end = new Date()
    const s: Submitted = { q: text.trim(), regex, ignoreCase, start: new Date(end.getTime() - minutes * 60_000).toISOString(), end: end.toISOString() }
    setSubmitted(s)
    void run(s, undefined)
  }, [text, regex, ignoreCase, minutes, run])

  // Opening the view, or a different pod / container / workload, searches once.
  useEffect(() => {
    search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCluster, namespace, pod, container, workload?.kind, workload?.name])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    search()
  }

  const sm = size === 'sm'
  const buttonSize = sm ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'
  const toggleSize = sm ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm'
  const toggleOn = 'bg-primary-600 border-primary-500 text-white'
  const toggleOff = 'bg-slate-800 border-slate-600 text-slate-400 hover:text-white'
  const showPod = !pod
  const showContainer = !container
  const rangeLabel = (m: number) =>
    m < 60 ? t('clusterView.logSearch.minutes', '{{count}} min', { count: m }) : t('clusterView.logSearch.hours', '{{count}} h', { count: m / 60 })

  return (
    <div className={sm ? 'space-y-2' : 'flex flex-col h-full'} data-testid="logsearch-view">
      <form
        onSubmit={onSubmit}
        className={sm ? 'flex flex-wrap items-center gap-2' : 'flex flex-wrap items-end gap-4 pb-4 shrink-0 border-b border-slate-700'}
      >
        {leading}
        <input
          type="search"
          data-testid="logsearch-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={256}
          placeholder={regex ? t('clusterView.logSearch.regexPlaceholder', 'Regular expression (RE2)') : t('clusterView.logSearch.placeholder', 'Text in the line')}
          aria-label={t('clusterView.logSearch.textLabel', 'Search text')}
          className={`${sm ? 'h-8 text-xs min-w-[140px]' : 'h-10 text-sm min-w-[260px]'} flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 text-white placeholder:text-slate-500 focus:outline-none focus:border-primary-500`}
        />
        <CustomDropdown
          size={sm ? 'sm' : 'md'}
          className={sm ? 'w-24' : 'min-w-[110px]'}
          testId="logsearch-range"
          value={String(minutes)}
          onChange={(v) => setMinutes(Number(v))}
          options={ranges.map((m) => ({ value: String(m), label: rangeLabel(m) }))}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="logsearch-regex"
            aria-pressed={regex}
            title={t('clusterView.logSearch.regex', 'Regular expression')}
            aria-label={t('clusterView.logSearch.regex', 'Regular expression')}
            onClick={() => setRegex((r) => !r)}
            className={`${toggleSize} rounded-lg border font-mono transition-colors ${regex ? toggleOn : toggleOff}`}
          >
            .*
          </button>
          <button
            type="button"
            data-testid="logsearch-match-case"
            aria-pressed={!ignoreCase}
            title={t('clusterView.logSearch.matchCase', 'Match case')}
            aria-label={t('clusterView.logSearch.matchCase', 'Match case')}
            onClick={() => setIgnoreCase((c) => !c)}
            className={`${toggleSize} rounded-lg border font-mono transition-colors ${!ignoreCase ? toggleOn : toggleOff}`}
          >
            Aa
          </button>
        </div>
        <button
          type="submit"
          data-testid="logsearch-submit"
          disabled={busy}
          className={`${buttonSize} rounded-lg border border-primary-500 bg-primary-600 text-white hover:bg-primary-700 whitespace-nowrap flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <Search className={sm ? 'w-3 h-3' : 'w-4 h-4'} />
          {t('clusterView.logSearch.search', 'Search')}
        </button>
      </form>
      <p className={`text-xs text-slate-500 ${sm ? '' : 'mt-3'}`} data-testid="logsearch-summary">
        {submitted && !busy && !error
          ? t('clusterView.logSearch.summary', '{{count}} lines from the last {{range}} · {{bytes}} scanned.', {
              count: lines.length,
              range: rangeLabel(minutes),
              bytes: formatBytes(bytes),
            }) + ' '
          : ''}
        {t('clusterView.logSearch.notice', 'Lines come from the log store, including pods that are gone. Each search is recorded in the audit log.')}
      </p>
      <div
        data-testid="logsearch-output"
        className={
          sm
            ? 'bg-slate-950 rounded-lg p-3 font-mono text-[11px] text-slate-300 max-h-[400px] overflow-auto'
            : 'flex-1 bg-slate-900 rounded-lg p-4 mt-3 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto'
        }
      >
        {error ? (
          <p className="text-red-400 whitespace-pre-wrap" data-testid="logsearch-error">{error}</p>
        ) : busy && lines.length === 0 ? (
          <p className="text-slate-500">{t('clusterView.logSearch.searching', 'Searching...')}</p>
        ) : lines.length === 0 ? (
          <p className="text-slate-500" data-testid="logsearch-empty">{t('clusterView.logSearch.noLines', 'No lines in this range.')}</p>
        ) : (
          <ul className="space-y-0.5">
            {lines.map((l, i) => {
              const href = traceHref(l)
              return (
                <li key={`${l.ts}-${i}`} data-testid="logsearch-line" className="flex gap-3">
                  <span className="shrink-0 text-slate-500 tabular-nums" title={absoluteTitle(l.ts)}>{formatTime(l.ts)}</span>
                  {showPod && <span className="shrink-0 text-sky-400" data-testid="logsearch-line-pod">{l.pod}</span>}
                  {showContainer && <span className="shrink-0 text-violet-400">{l.container}</span>}
                  <span className="min-w-0 whitespace-pre-wrap wrap-break-word" data-testid="logsearch-line-text">
                    {highlightParts(l.line, submitted?.q ?? '', submitted?.regex ?? false, submitted?.ignoreCase ?? false).map((p, j) =>
                      p.match ? (
                        <mark key={j} className="bg-amber-500/30 text-amber-100 rounded-sm">{p.text}</mark>
                      ) : (
                        <span key={j}>{p.text}</span>
                      ),
                    )}
                  </span>
                  {href && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="logsearch-line-trace"
                      title={t('clusterView.logSearch.traceTitle', 'Open trace {{id}} in a new tab', { id: l.traceId })}
                      className="shrink-0 self-start ml-auto inline-flex items-center gap-1 text-sky-400 hover:text-sky-300"
                    >
                      <Waypoints className="w-3 h-3" />
                      {t('clusterView.logSearch.trace', 'Trace')}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {truncated && !error && submitted && oldest && (
        <button
          type="button"
          data-testid="logsearch-older"
          disabled={busy}
          onClick={() => void run(submitted, oldest)}
          className={`${buttonSize} rounded-lg border border-slate-600 bg-slate-700 text-white hover:bg-slate-600 whitespace-nowrap flex items-center gap-2 transition-colors disabled:opacity-50 ${sm ? '' : 'mt-3 self-start'}`}
        >
          <History className={sm ? 'w-3 h-3' : 'w-4 h-4'} />
          {t('clusterView.logSearch.older', 'Load older')}
        </button>
      )}
    </div>
  )
}
