// Optimization suggestions modal — namespace picker + Generate /
// Stop / Copy buttons + streaming markdown body. The streaming
// state (isStreaming / observed / answer markdown / usage / meta /
// error / copied) is owned by Dashboard.tsx and passed in; the
// dropdown's outside-click detection is local to this component.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  Copy,
  RefreshCw,
  StopCircle,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ModalOverlay } from '@/components/ModalOverlay'

interface UsageInfo {
  completion_tokens?: number
}

interface MetaInfo {
  finish_reason?: string | null
  max_tokens?: number | null
}

interface Props {
  open: boolean
  onClose: () => void

  // Namespace picker
  namespace: string
  setNamespace: (ns: string) => void
  namespaces: string[]
  isLoadingNamespaces: boolean
  isDropdownOpen: boolean
  setIsDropdownOpen: (b: boolean) => void

  // Streaming state
  isStreaming: boolean
  copied: boolean
  fullMarkdown: string
  observedMarkdown: string
  answerMarkdown: string
  answerMarkdownForStreaming: string
  answerContent: string
  streamError: string
  usage: UsageInfo | null
  meta: MetaInfo | null

  // Handlers
  onRun: () => void
  onStop: () => void
  onCopy: () => void
}

export function OptimizationModal({
  open,
  onClose,
  namespace,
  setNamespace,
  namespaces,
  isLoadingNamespaces,
  isDropdownOpen,
  setIsDropdownOpen,
  isStreaming,
  copied,
  fullMarkdown,
  observedMarkdown,
  answerMarkdown,
  answerMarkdownForStreaming,
  answerContent,
  streamError,
  usage,
  meta,
  onRun,
  onStop,
  onCopy,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const na = tr('common.notAvailable', 'N/A')

  // Outside-click → close namespace dropdown.
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDropdownOpen, setIsDropdownOpen])

  if (!open) return null

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg max-w-[98vw] w-full h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">
                {tr('dashboard.optimization.title', 'Optimization suggestions')}
              </h2>
              <p className="text-xs text-slate-400">
                {tr(
                  'dashboard.optimization.subtitle',
                  'AI suggests optimizations based on Deployment/Pod data in the selected namespace.',
                )}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[240px] justify-between disabled:opacity-60 disabled:cursor-not-allowed"
                title={tr('dashboard.optimization.selectNamespaceTitle', 'Select namespace')}
                disabled={isLoadingNamespaces}
              >
                <span className="text-xs font-medium truncate">
                  {namespace || (isLoadingNamespaces
                    ? tr('dashboard.loading', 'Loading...')
                    : tr('dashboard.optimization.selectNamespace', 'Select namespace'))}
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-slate-400 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {isDropdownOpen && (
                <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[340px] overflow-y-auto">
                  {namespaces.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-slate-200">
                      {tr('dashboard.optimization.noNamespaces', 'No namespaces to display')}
                    </div>
                  ) : (
                    namespaces.map((ns) => (
                      <button
                        key={ns}
                        onClick={() => {
                          setNamespace(ns)
                          setIsDropdownOpen(false)
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                      >
                        {namespace === ns && (
                          <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                        )}
                        <span className={namespace === ns ? 'font-medium' : ''}>{ns}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={onRun}
                disabled={!namespace || isStreaming}
                className="h-9 px-3 rounded-lg text-xs font-medium transition-colors bg-primary-600 hover:bg-primary-500 text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center gap-2"
                title={tr('dashboard.optimization.runTitle', 'Generate AI suggestion')}
              >
                {isStreaming && (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                )}
                {isStreaming
                  ? tr('dashboard.optimization.running', 'Generating...')
                  : tr('dashboard.optimization.run', 'Generate')}
              </button>

              {isStreaming && (
                <button
                  onClick={onStop}
                  className="h-10 px-4 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-2"
                  title={tr('dashboard.optimization.stopTitle', 'Stop')}
                >
                  <StopCircle className="w-4 h-4" />
                  {tr('dashboard.optimization.stop', 'Stop')}
                </button>
              )}

              <button
                onClick={onCopy}
                disabled={!fullMarkdown}
                className="h-9 px-3 rounded-lg text-xs font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                title={tr('dashboard.optimization.copyTitle', 'Copy result')}
              >
                <Copy className="w-4 h-4" />
                {copied
                  ? tr('dashboard.optimization.copied', 'Copied')
                  : tr('dashboard.optimization.copy', 'Copy')}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="badge badge-info">
              {tr('dashboard.optimization.namespaceBadge', 'Namespace {{namespace}}', {
                namespace: namespace || na,
              })}
            </span>
            {!!usage && (
              <span className="badge badge-info">
                {tr('dashboard.optimization.tokensBadge', 'Tokens {{used}}{{max}}', {
                  used: usage.completion_tokens,
                  max: meta?.max_tokens ? `/${meta.max_tokens}` : '',
                })}
              </span>
            )}
            {!!meta?.finish_reason && meta.finish_reason !== 'stop' && (
              <span className={`text-xs ${meta.finish_reason === 'length' ? 'text-yellow-300' : 'text-yellow-200'}`}>
                {tr(
                  'dashboard.optimization.finishReason',
                  'The response did not end with stop and may be truncated ({{reason}})',
                  { reason: meta.finish_reason },
                )}
              </span>
            )}
            {!!streamError && (
              <span className="text-xs text-red-300 wrap-break-word">
                {tr('dashboard.optimization.streamError', 'Stream error')}: {streamError}
              </span>
            )}
            <span className="text-[11px] text-slate-500">
              {tr('dashboard.optimization.modelLatency', 'Model calls can take up to ~1 minute')}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isStreaming && !fullMarkdown ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
              <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
              <p className="text-slate-400">
                {tr('dashboard.optimization.generating', 'Generating optimization suggestions...')}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {tr('dashboard.optimization.waiting', 'Waiting for OpenAI response')}
              </p>
            </div>
          ) : streamError && !fullMarkdown ? (
            <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100">
                    {tr('dashboard.optimization.failed', 'Failed to generate suggestions')}
                  </p>
                  <p className="text-xs text-slate-400 mt-1 wrap-break-word">{streamError}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={onRun}
                      className="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200"
                    >
                      {tr('dashboard.optimization.retry', 'Retry')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : !fullMarkdown ? (
            <div className="text-center py-12">
              <p className="text-slate-400">
                {tr('dashboard.optimization.selectPrompt', 'Select a namespace then click “Generate”.')}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {tr(
                  'dashboard.optimization.promptNote',
                  '(The API summarizes Deployment/Pod lists and asks AI for optimization ideas.)',
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              {!!observedMarkdown && (
                <details className="rounded-lg border border-slate-700 bg-slate-900/20 p-3">
                  <summary className="cursor-pointer select-none text-xs font-medium text-slate-200">
                    {tr('dashboard.optimization.observedData', 'Observed data (table)')}
                  </summary>
                  <div className="mt-2 prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{observedMarkdown}</ReactMarkdown>
                  </div>
                </details>
              )}

              <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-3">
                {isStreaming ? (
                  <div className="prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{answerMarkdownForStreaming}</ReactMarkdown>
                    {!answerContent && (
                      <p className="text-[11px] text-slate-500">
                        {tr('dashboard.optimization.writing', 'AI is drafting suggestions…')}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{answerMarkdown}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
