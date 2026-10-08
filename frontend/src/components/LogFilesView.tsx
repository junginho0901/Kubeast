// Log files inside a container (chart features.logFiles), shared by the
// cluster view's Logs tab and the Pod drawer. The server runs a fixed ls/tail
// through pods/exec; this lists the files, reads the last lines, or follows
// one file over Server-Sent Events.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Radio } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'
import { api } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'

const LINE_OPTIONS = [100, 500, 1000, 2000]
// Following keeps this many lines on screen; older ones scroll away.
const FOLLOW_KEEP_LINES = 5000

export type LogSource = 'stdout' | 'files'

export function LogSourceToggle({
  value,
  onChange,
  size = 'md',
}: {
  value: LogSource
  onChange: (v: LogSource) => void
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation()
  const item = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
  const options: Array<{ v: LogSource; label: string }> = [
    { v: 'stdout', label: t('clusterView.logFiles.sourceStdout', 'Container output') },
    { v: 'files', label: t('clusterView.logFiles.sourceFiles', 'Log files') },
  ]
  return (
    <div
      role="group"
      aria-label={t('clusterView.logFiles.sourceLabel', 'Log source')}
      className="inline-flex rounded-lg border border-slate-700 bg-slate-900/60 p-1"
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          data-testid={`log-source-${o.v}`}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={`${item} rounded-md whitespace-nowrap transition-colors ${
            value === o.v ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function keepLastLines(text: string): string {
  let count = 0
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 10 && ++count > FOLLOW_KEEP_LINES) return text.slice(i + 1)
  }
  return text
}

interface Props {
  namespace: string
  pod: string
  container: string
  size?: 'sm' | 'md'
  // Rendered first in the controls row (the container picker).
  leading?: ReactNode
}

export function LogFilesView({ namespace, pod, container, size = 'md', leading }: Props) {
  const { t } = useTranslation()
  const { currentCluster } = useCluster()
  const { data: features } = useClusterFeatures()
  const maxLines = features?.logFiles?.maxLines || 2000
  const lineOptions = LINE_OPTIONS.filter((n) => n <= maxLines)
  if (lineOptions.length === 0) lineOptions.push(maxLines)

  const [path, setPath] = useState('')
  const [lines, setLines] = useState(lineOptions[0])
  const [follow, setFollow] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamNote, setStreamNote] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const errorText = (err: any): string => {
    const reason: string | undefined = err?.response?.data?.reason
    const detail: string = err?.response?.data?.detail || err?.message || ''
    if (reason && reason !== 'failed' && reason !== 'lines') {
      return t(`clusterView.logFiles.errors.${reason}`, detail)
    }
    return t('clusterView.logFiles.errors.generic', 'Could not read the file: {{detail}}', { detail })
  }

  const list = useQuery({
    queryKey: ['log-files', currentCluster, namespace, pod, container],
    queryFn: () => api.listLogFiles(namespace, pod, container),
    enabled: !!container,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const files = list.data?.files ?? []

  // Keep the chosen file while it is still listed; otherwise take the first.
  useEffect(() => {
    const listed = list.data?.files ?? []
    if (listed.length === 0) {
      setPath('')
      setFollow(false)
    } else if (!listed.some((f) => f.path === path)) {
      setPath(listed[0].path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data])

  // Every read is an audited exec: no refetch on focus or remount, only on a
  // change of file or line count, or the Refresh button.
  const content = useQuery({
    queryKey: ['log-file-content', currentCluster, namespace, pod, container, path, lines],
    queryFn: () => api.getLogFileContent(namespace, pod, container, path, lines),
    enabled: !!container && !!path && !follow,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!follow || !path || !container) return
    setStreamText('')
    setStreamNote(null)
    // EventSource bypasses the axios cluster interceptor — add ?cluster=.
    const clusterId = getCurrentClusterID()
    const url =
      `/api/v1/cluster/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/logfiles/stream` +
      `?container=${encodeURIComponent(container)}&path=${encodeURIComponent(path)}&lines=${lines}` +
      (clusterId ? `&cluster=${encodeURIComponent(clusterId)}` : '')
    const es = new EventSource(url, { withCredentials: true })
    es.onmessage = (e) => setStreamText((prev) => keepLastLines(prev + e.data + '\n'))
    es.addEventListener('notice', (e) => {
      setStreamText((prev) => keepLastLines(prev + '» ' + (e as MessageEvent).data + '\n'))
    })
    es.addEventListener('end', () => {
      es.close()
      setFollow(false)
      setStreamNote(t('clusterView.logFiles.streamEnded', 'Following stopped.'))
    })
    // Never let the browser reconnect on its own: a reconnect reads the last
    // lines again (duplicates on screen) and is another audited read. After a
    // stop the content view re-reads the file, which also shows why it failed.
    es.onerror = (e) => {
      es.close()
      setFollow(false)
      const reason = (e as MessageEvent).data || t('clusterView.logs.streamError', 'An error occurred while streaming logs.')
      setStreamNote(t('clusterView.logFiles.streamFailed', 'Following stopped: {{reason}}', { reason }))
    }
    return () => es.close()
  }, [follow, path, lines, container, namespace, pod, currentCluster, t])

  // The newest lines are at the end: keep them in view, as the container output does.
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [streamText, follow, content.data])

  const sm = size === 'sm'
  const buttonSize = sm ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'
  const labelFor = (text: string) => (sm ? undefined : text)

  let body: string
  if (list.isLoading) body = t('clusterView.logFiles.loadingList', 'Loading files...')
  else if (list.isError) body = errorText(list.error)
  else if (files.length === 0)
    body = t('clusterView.logFiles.noFiles', 'No files at the configured paths: {{patterns}}', {
      patterns: (list.data?.patterns ?? []).join(', '),
    })
  else if (follow) body = streamText || t('clusterView.logFiles.waiting', 'Waiting for new lines...')
  else if (content.isFetching) body = t('clusterView.logFiles.loadingContent', 'Reading file...')
  else if (content.isError) body = errorText(content.error)
  else body = content.data?.content || t('clusterView.logFiles.emptyFile', 'The file is empty.')

  return (
    <div className={sm ? 'space-y-2' : 'flex flex-col h-full'}>
      <div className={sm ? 'flex flex-wrap items-center gap-2' : 'flex flex-wrap items-end gap-4 pb-4 shrink-0 border-b border-slate-700'}>
        {leading}
        <CustomDropdown
          size={sm ? 'sm' : 'md'}
          className={sm ? 'w-56' : 'min-w-[260px]'}
          label={labelFor(t('clusterView.logFiles.fileLabel', 'File'))}
          testId="logfile-select"
          value={path}
          onChange={(v) => setPath(v)}
          disabled={files.length === 0}
          placeholder="—"
          options={files.map((f) => ({ value: f.path, label: f.path }))}
        />
        <CustomDropdown
          size={sm ? 'sm' : 'md'}
          className={sm ? 'w-28' : 'min-w-[130px]'}
          label={labelFor(t('clusterView.logFiles.linesLabel', 'Lines'))}
          testId="logfile-lines"
          value={String(lines)}
          onChange={(v) => setLines(Number(v))}
          options={lineOptions.map((n) => ({
            value: String(n),
            label: t('clusterView.logs.linesCount', '{{count}} lines', { count: n }),
          }))}
        />
        <div>
          {!sm && <span className="block text-xs font-semibold text-slate-400 mb-1 invisible">.</span>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="logfile-follow"
              aria-pressed={follow}
              disabled={!path}
              onClick={() => {
                setStreamNote(null)
                setFollow((f) => !f)
              }}
              className={`${buttonSize} rounded-lg border whitespace-nowrap flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                follow
                  ? 'bg-primary-600 border-primary-500 text-white hover:bg-primary-700'
                  : 'bg-slate-700 border-slate-600 text-white hover:bg-slate-600'
              }`}
            >
              <Radio className={`${sm ? 'w-3 h-3' : 'w-4 h-4'} ${follow ? 'animate-pulse' : ''}`} />
              {t('clusterView.logFiles.follow', 'Follow')}
            </button>
            <button
              type="button"
              data-testid="logfile-refresh"
              disabled={!path || follow || content.isFetching}
              onClick={() => {
                setStreamNote(null)
                void list.refetch()
                void content.refetch()
              }}
              className={`${buttonSize} rounded-lg border border-slate-600 bg-slate-700 text-white hover:bg-slate-600 whitespace-nowrap flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <RefreshCw className={`${sm ? 'w-3 h-3' : 'w-4 h-4'} ${content.isFetching ? 'animate-spin' : ''}`} />
              {t('clusterView.logFiles.refresh', 'Refresh')}
            </button>
          </div>
        </div>
      </div>
      <p className={`text-xs text-slate-500 ${sm ? '' : 'mt-3'}`}>
        {t('clusterView.logFiles.notice', 'File contents are shown as they are, without masking. Each read is recorded in the audit log.')}
        {!follow && content.data?.truncated ? ` ${t('clusterView.logFiles.truncated', 'The output is large; only its end is shown.')}` : ''}
        {streamNote ? ` ${streamNote}` : ''}
      </p>
      <div
        ref={outputRef}
        data-testid="logfile-output"
        className={
          sm
            ? 'bg-slate-950 rounded-lg p-3 font-mono text-[11px] text-slate-300 max-h-[400px] overflow-auto'
            : 'flex-1 bg-slate-900 rounded-lg p-4 mt-3 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto'
        }
      >
        <pre className={sm ? 'whitespace-pre-wrap break-all' : 'whitespace-pre-wrap wrap-break-word'}>{body}</pre>
      </div>
    </div>
  )
}
