import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'

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
  labels,
}: YamlEditorProps) {
  const [draft, setDraft] = useState(value || '')
  const [isEditing, setIsEditing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applySuccess, setApplySuccess] = useState(false)
  const [copied, setCopied] = useState(false)

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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const target = event.currentTarget
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? 0
    const insert = '  '
    const next = `${draft.slice(0, start)}${insert}${draft.slice(end)}`
    setDraft(next)
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = start + insert.length
    })
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
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || labels.error
      setApplyError(String(detail))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400">{labels.title}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white"
          >
            {labels.refresh}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className={`relative inline-flex items-center justify-center px-2 py-1 text-xs rounded border border-slate-700 min-w-[52px] ${
              copied ? 'text-emerald-300' : 'text-slate-300 hover:text-white'
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
                    disabled={isApplying}
                    className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white disabled:opacity-50"
                  >
                    {isApplying ? labels.applying : labels.apply}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false)
                      setDraft(value || '')
                    }}
                    className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white"
                  >
                    {labels.cancel}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:text-white"
                >
                  {labels.edit}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isLoading && !value ? (
        <p className="text-slate-400">{labels.loading}</p>
      ) : error ? (
        <p className="text-red-400">{labels.error}</p>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={!canEdit || !isEditing}
          className="w-full flex-1 min-h-[420px] rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs text-slate-200 font-mono whitespace-pre overflow-auto"
        />
      )}

      {isRefreshing && (
        <p className="text-[11px] text-slate-500">{labels.refreshing}</p>
      )}
      <p className="text-[11px] text-slate-500">
        {canEdit ? labels.editHint : labels.readonly}
      </p>
      {applyError && <p className="text-xs text-red-400">{applyError}</p>}
      {applySuccess && <p className="text-xs text-emerald-300">{labels.applied}</p>}
    </div>
  )
}
