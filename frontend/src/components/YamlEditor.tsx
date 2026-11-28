import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type OnMount } from '@/components/monaco/CodeEditor'
import { followTabMovesFocus } from '@/components/monaco/tabMovesFocus'
import { isMacPlatform } from '@/hooks/useChatShortcut'
import { copyText } from '@/utils/clipboard'
import { refocusIfDropped } from '@/utils/focusDrop'
import { tabFocusKeyNames } from '@/utils/terminalTabFocus'

// Where the focus goes once the buttons have changed: the editor after Edit, Edit after a save or Cancel, Apply when
// nothing was saved.
export type YamlFocusNext = 'editor' | 'edit' | 'apply'

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
  // false: nothing was written (the user declined), so the edit stays and nothing is called applied.
  // opened: the text when Edit was pressed, which a later refresh of `value` does not change.
  onApply?: (nextValue: string, opened: string) => Promise<boolean>
  onApplySuccess?: () => void
  onApplyError?: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
  toast?: { type: 'success' | 'error'; message: string } | null
  showInlineApplied?: boolean
  labels: Labels
  // One line under the hint, for what a save of this object does beyond what the text says.
  note?: string
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
  note,
}: YamlEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value || '')
  const [isEditing, setIsEditing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applySuccess, setApplySuccess] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [opened, setOpened] = useState('')
  const [focusNext, setFocusNext] = useState<YamlFocusNext | null>(null)
  // Monaco's own Tab switch (Ctrl+M, Ctrl+Shift+M on a Mac), read back from Monaco so the hint follows it.
  const [tabMovesFocus, setTabMovesFocus] = useState(false)
  const [editorMounted, setEditorMounted] = useState(false)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const applyButtonRef = useRef<HTMLButtonElement>(null)
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

  // Copied stays until the text changes or the next press, as a pressed button's result does on every screen
  useEffect(() => {
    setCopied(false)
    setCopyFailed(false)
  }, [draft])


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

  // The pressed button is gone (or was disabled while applying), so the focus fell to the page (WCAG 2.4.3). A disabled
  // button takes no focus, so the move also waits out a read of the YAML, which the drawer makes after every Apply.
  useEffect(() => {
    if (!focusNext || isApplying || !isReady) return
    const next = focusNext === 'editor' ? editorRef.current : focusNext === 'edit' ? editButtonRef.current : applyButtonRef.current
    // Edit pressed before Monaco has mounted: the request waits for the mount
    if (focusNext === 'editor' && !next) return
    refocusIfDropped(document, next)
    setFocusNext(null)
  }, [focusNext, isApplying, isReady, editorMounted])

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    setEditorMounted(true)
    followTabMovesFocus(editor, monaco.editor.EditorOption.tabFocusMode, setTabMovesFocus)
  }

  const handleCopy = async () => {
    if (!draft) return
    const ok = await copyText(draft)
    setCopied(ok)
    setCopyFailed(!ok)
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
      if (!(await onApply(sanitized, opened))) {
        setFocusNext('apply')
        return
      }
      setIsEditing(false)
      setApplySuccess(true)
      setFocusNext('edit')
      onApplySuccess?.()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || labels.error
      setApplyError(String(detail))
      setFocusNext('apply')
      onApplyError?.(String(detail))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
        <p className="min-w-0 text-xs text-slate-400 [overflow-wrap:anywhere]">{labels.title}</p>
        <div className="flex flex-wrap items-center gap-2">
          {/* aria-disabled during a read, not disabled: a disabled button drops the focus it had to the page */}
          <button
            type="button"
            onClick={() => { if (!isRefreshing) onRefresh?.() }}
            disabled={!isReady}
            aria-disabled={isRefreshing || undefined}
            className="btn-row aria-disabled:opacity-50"
          >
            {labels.refresh}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!isReady || !draft}
            className={`relative inline-flex items-center justify-center px-2.5 py-1 text-xs rounded-lg border min-w-[52px] disabled:opacity-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 ${
              copied ? 'text-emerald-300 border-emerald-500/40' : copyFailed ? 'text-red-400 border-red-500/40' : 'border-control bg-slate-800 text-slate-300 hover:text-ink hover:bg-slate-700'
            }`}
            title={copyFailed ? t('common.copyFailed', { defaultValue: 'Not copied: the browser did not take it. Select the text and copy it yourself.' }) : undefined}
            data-testid="yaml-copy"
          >
            {copied ? t('common.copied', { defaultValue: 'Copied' }) : copyFailed ? t('common.notCopied', { defaultValue: 'Not copied' }) : labels.copy}
          </button>
          {canEdit && (
            <>
              {/* keyed, so Apply never takes over the pressed Edit and its focus */}
              {isEditing ? (
                <>
                  <button
                    key="apply"
                    ref={applyButtonRef}
                    type="button"
                    onClick={handleApply}
                    disabled={isApplying || !isReady}
                    className="px-2.5 py-1 text-xs rounded-lg border border-primary-600 bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                  >
                    {isApplying ? labels.applying : labels.apply}
                  </button>
                  <button
                    key="cancel"
                    type="button"
                    onClick={() => {
                      setIsEditing(false)
                      setDraft(value || '')
                      setFocusNext('edit')
                    }}
                    disabled={!isReady}
                    className="btn-row"
                  >
                    {labels.cancel}
                  </button>
                </>
              ) : (
                <button
                  key="edit"
                  ref={editButtonRef}
                  type="button"
                  onClick={() => {
                    setOpened(draft)
                    setIsEditing(true)
                    setFocusNext('editor')
                  }}
                  disabled={!isReady}
                  className="btn-row"
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
        <div className="px-5 py-8 text-red-400 text-sm break-words" role="alert" data-testid="yaml-read-error">{error || labels.error}</div>
      ) : (
        <div className="relative min-w-0 flex-1 min-h-[520px]">
          {toast && (
            <div
              data-testid="yaml-apply-toast"
              data-type={toast.type}
              role={toast.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-none absolute right-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-lg border px-3 py-1.5 text-xs [overflow-wrap:anywhere] shadow-lg ${
                toast.type === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-red-500/40 bg-red-500/15 text-red-200'
              }`}
            >
              {toast.message}
            </div>
          )}
          <div className="h-full min-h-[520px] border-y border-hairline overflow-hidden">
            <Editor
              height="100%"
              theme="vs-dark"
              language="yaml"
              value={draft}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={editorOptions}
              loading={<div className="p-3 text-xs text-slate-400">{labels.loading}</div>}
            />
          </div>
        </div>
      )}

      {/* Footer hints */}
      <div className="px-5 py-3 space-y-1 [overflow-wrap:anywhere]">
        {isRefreshing && (
          <p className="text-xs text-slate-400">{labels.refreshing}</p>
        )}
        <p className="text-xs text-slate-400">
          {canEdit && isEditing ? labels.editHint : labels.readonly}
        </p>
        {canEdit && isEditing && (
          <p className="text-xs text-slate-400" data-testid="yaml-editor-tab-hint" data-tab-moves-focus={tabMovesFocus ? 'true' : 'false'}>
            {tabMovesFocus
              ? t('keyboardHelp.editorTabMovesFocus', { key: tabFocusKeyNames(isMacPlatform()).label, defaultValue: 'Tab moves the focus out of the editor. Press {{key}} to indent with Tab again.' })
              : t('keyboardHelp.editorTab', { key: tabFocusKeyNames(isMacPlatform()).label, defaultValue: 'Tab indents. Press {{key}} to move the focus with Tab instead.' })}
          </p>
        )}
        {note && <p className="text-xs text-slate-400" data-testid="yaml-editor-note">{note}</p>}
        {applyError && <p className="text-xs text-red-400" role="alert">{applyError}</p>}
        {showInlineApplied && applySuccess && !toast && (
          <p className="text-xs text-emerald-300" role="status">{labels.applied}</p>
        )}
      </div>
    </div>
  )
}
