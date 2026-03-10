import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import Editor from '@monaco-editor/react'

type Labels = {
  title: string
  refresh: string
  copy: string
  edit: string
  apply: string
  applying: string
  cancel: string
  loading: string
  error: string
  readonly: string
  editHint: string
  applied: string
  refreshing: string
}

type YamlEditorProps = {
  value?: string
  canEdit: boolean
  isLoading: boolean
  isRefreshing?: boolean
  error?: string | null
  onRefresh?: () => void
  onApply?: (nextValue: string) => Promise<void>
  onApplySuccess?: () => void
  onApplyError?: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
  toast?: { type: 'success' | 'error'; message: string } | null
  showInlineApplied?: boolean
  labels: Labels
}

export default function YamlEditor({
  value,
  canEdit,
  isLoading,
  isRefreshing = false,
  error,
  onRefresh,
  onApply,
  onApplySuccess,
  onApplyError,
  onDirtyChange,
  toast,
  showInlineApplied = true,
  labels,
}: YamlEditorProps) {
  const [draft, setDraft] = useState(value || '')
  const [isEditing, setIsEditing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applySuccess, setApplySuccess] = useState(false)
  const [copied, setCopied] = useState(false)
  const isReady = !isLoading && !error && value !== undefined
  const editorOptions = useMemo(
    () => ({
      readOnly: !canEdit || !isEditing,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none' as const,
      wordWrap: 'off' as const,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    }),
    [canEdit, isEditing]
  )

  useEffect(() => {
    if (!isEditing) {
      setDraft(value || '')
    }
  }, [value, isEditing])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!applySuccess) return
    const timer = setTimeout(() => setApplySuccess(false), 3000)
    return () => clearTimeout(timer)
  }, [applySuccess])

  useEffect(() => {
    if (!onDirtyChange) return
    const dirty = isEditing && draft !== (value || '')
    onDirtyChange(dirty)
  }, [draft, isEditing, onDirtyChange, value])

  const handleCopy = async () => {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(draft)
    } catch (error) {
      const textarea = document.createElement('textarea')
      textarea.value = draft
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopied(true)
  }

  const handleEditorChange = (nextValue?: string) => {
    setDraft(nextValue ?? '')
  }

  const handleApply = async () => {
    if (!onApply) return
    setApplyError(null)
    setIsApplying(true)
    const sanitized = draft.replace(/\t/g, '  ')
    if (sanitized !== draft) {
      setDraft(sanitized)
    }
    try {
      await onApply(sanitized)
      setIsEditing(false)
      setApplySuccess(true)
      onApplySuccess?.()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || labels.error
      setApplyError(String(detail))
      onApplyError?.(String(detail))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
        <p className="text-xs text-slate-400 truncate">{labels.title}</p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={!isReady || isRefreshing}
            className="px-2.5 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 transition-colors"
          >
            {labels.refresh}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!isReady || !draft}
            className={`relative inline-flex items-center justify-center px-2.5 py-1 text-xs rounded border border-slate-700 min-w-[52px] disabled:opacity-50 transition-colors ${
              copied ? 'text-emerald-300 border-emerald-500/40' : 'text-slate-300 hover:text-white hover:border-slate-500'
            }`}
          >
            <span className={copied ? 'opacity-0' : 'opacity-100'}>{labels.copy}</span>
            <Check className={`absolute w-3 h-3 ${copied ? 'opacity-100' : 'opacity-0'}`} />
          </button>
          {canEdit && (
            <>
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={isApplying || !isReady}
                    className="px-2.5 py-1 text-xs rounded border border-sky-600 bg-sky-600/20 text-sky-300 hover:bg-sky-600/30 disabled:opacity-50 transition-colors"
                  >
                    {isApplying ? labels.applying : labels.apply}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false)
                      setDraft(value || '')
                    }}
                    disabled={!isReady}
                    className="px-2.5 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                  >
                    {labels.cancel}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  disabled={!isReady}
                  className="px-2.5 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 transition-colors"
                >
                  {labels.edit}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Editor */}
      {isLoading && !value ? (
        <div className="px-5 py-8 text-slate-400 text-sm">{labels.loading}</div>
      ) : error ? (
        <div className="px-5 py-8 text-red-400 text-sm">{labels.error}</div>
      ) : (
        <div className="relative flex-1 min-h-[520px]">
          {toast && (
            <div
              className={`pointer-events-none absolute right-3 top-3 z-10 rounded-lg border px-3 py-1.5 text-xs shadow-lg ${
                toast.type === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-red-500/40 bg-red-500/15 text-red-200'
              }`}
            >
              {toast.message}
            </div>
          )}
          <div className="h-full min-h-[520px] border-y border-slate-700 overflow-hidden">
            <Editor
              height="100%"
              theme="vs-dark"
              language="yaml"
              value={draft}
              onChange={handleEditorChange}
              options={editorOptions}
              loading={<div className="p-3 text-xs text-slate-400">{labels.loading}</div>}
            />
          </div>
        </div>
      )}

      {/* Footer hints */}
      <div className="px-5 py-3 space-y-1">
        {isRefreshing && (
          <p className="text-[11px] text-slate-500">{labels.refreshing}</p>
        )}
        <p className="text-[11px] text-slate-500">
          {canEdit ? labels.editHint : labels.readonly}
        </p>
        {applyError && <p className="text-xs text-red-400">{applyError}</p>}
        {showInlineApplied && applySuccess && !toast && (
          <p className="text-xs text-emerald-300">{labels.applied}</p>
        )}
      </div>
    </div>
  )
}
