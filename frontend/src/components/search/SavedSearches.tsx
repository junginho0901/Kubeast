import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, BookmarkPlus, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { useConfirm } from '@/services/confirm'
import {
  MAX_SAVED,
  addSavedSearch,
  deleteSavedSearch,
  readSavedSearches,
  renameSavedSearch,
  writeSavedSearches,
  type SavedSearch,
} from './savedSearchStore'

interface Props {
  query: string
  resources: Set<string>
  namespace: string
  onLoad: (search: SavedSearch) => void
}

// The Advanced Search toolbar's saved queries: "Save search" names the current expression, resource types and
// namespace; the list loads one back, renames or deletes it. Kept in this browser (savedSearchStore.ts).
export default function SavedSearches({ query, resources, namespace, onLoad }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [searches, setSearches] = useState<SavedSearch[]>(() => readSavedSearches())
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = (next: SavedSearch[]) => {
    setSearches(next)
    writeSavedSearches(next)
  }

  const submit = () => {
    if (!editing || !editing.name.trim()) return
    commit(
      editing.id
        ? renameSavedSearch(searches, editing.id, editing.name)
        : addSavedSearch(searches, { name: editing.name, query, resources: [...resources], namespace }),
    )
    setEditing(null)
  }

  const remove = async (s: SavedSearch) => {
    setOpen(false)
    const ok = await confirm({
      title: t('advancedSearch.saved.deleteTitle', 'Delete saved search'),
      message: t('advancedSearch.saved.deleteMessage', 'Delete "{{name}}"? It is kept only in this browser.', { name: s.name }),
      confirmLabel: t('advancedSearch.saved.delete', 'Delete'),
      danger: true,
    })
    if (ok) commit(deleteSavedSearch(searches, s.id))
  }

  return (
    <div className="flex items-center gap-2" ref={boxRef}>
      <button
        type="button"
        onClick={() => setEditing({ name: query.trim().slice(0, 60) })}
        disabled={!query.trim()}
        data-testid="saved-search-save"
        className="h-10 px-3 rounded-lg border border-slate-600 bg-slate-800 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
      >
        <BookmarkPlus className="w-4 h-4" />
        {t('advancedSearch.saved.save', 'Save search')}
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="saved-search-toggle"
          className="h-10 px-3 rounded-lg border border-slate-600 bg-slate-800 text-sm text-slate-200 hover:bg-slate-700 flex items-center gap-2"
        >
          <Bookmark className="w-4 h-4" />
          {t('advancedSearch.saved.list', 'Saved searches')}
          <span className="text-xs text-slate-400 tabular-nums" data-testid="saved-search-count">{searches.length}</span>
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-2 z-100 w-[min(28rem,90vw)] max-h-80 overflow-y-auto rounded-lg border border-slate-600 bg-slate-700 shadow-xl" data-testid="saved-search-menu">
            {searches.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-400">{t('advancedSearch.saved.empty', 'No saved searches yet.')}</p>
            ) : (
              searches.map((s) => (
                <div key={s.id} className="group flex items-start gap-2 px-3 py-2 hover:bg-slate-600/60" data-testid="saved-search-item">
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(s)
                      setOpen(false)
                    }}
                    className="flex-1 min-w-0 text-left"
                    data-testid="saved-search-load"
                  >
                    <span className="block truncate text-sm font-medium text-ink">{s.name}</span>
                    <span className="block truncate font-mono text-xs text-slate-400" title={s.query}>{s.query}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      setEditing({ id: s.id, name: s.name })
                    }}
                    title={t('advancedSearch.saved.rename', 'Rename')}
                    aria-label={t('advancedSearch.saved.rename', 'Rename')}
                    data-testid="saved-search-rename"
                    className="p-1 rounded-sm text-slate-400 hover:text-ink hover:bg-slate-600"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(s)}
                    title={t('advancedSearch.saved.delete', 'Delete')}
                    aria-label={t('advancedSearch.saved.delete', 'Delete')}
                    data-testid="saved-search-delete"
                    className="p-1 rounded-sm text-slate-400 hover:text-red-300 hover:bg-slate-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
            <p className="px-4 py-2 border-t border-slate-600 text-[11px] text-slate-400">
              {t('advancedSearch.saved.hint', 'Kept in this browser, up to {{max}}.', { max: MAX_SAVED })}
            </p>
          </div>
        )}
      </div>

      {editing && (
        <ModalFrame
          size="sm"
          title={editing.id ? t('advancedSearch.saved.renameTitle', 'Rename saved search') : t('advancedSearch.saved.saveTitle', 'Save this search')}
          onClose={() => setEditing(null)}
          testId="saved-search-dialog"
          footer={
            <>
              <button type="button" className={modalButton.cancel} onClick={() => setEditing(null)}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="button" className={modalButton.primary} onClick={submit} disabled={!editing.name.trim()} data-testid="saved-search-confirm">
                {editing.id ? t('advancedSearch.saved.rename', 'Rename') : t('advancedSearch.saved.save', 'Save search')}
              </button>
            </>
          }
        >
          <label className="block text-xs font-semibold text-slate-400 mb-1" htmlFor="saved-search-name">
            {t('advancedSearch.saved.nameLabel', 'Name')}
          </label>
          <input
            id="saved-search-name"
            autoFocus
            value={editing.name}
            maxLength={120}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            data-testid="saved-search-name"
            className="h-10 w-full px-3 rounded-lg border border-slate-600 bg-slate-900 text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-primary-500"
          />
        </ModalFrame>
      )}
    </div>
  )
}
