// Saved Advanced Search queries: a name, the expression, the resource types and the namespace, kept in this
// browser (as the page's resource choice is) — at most MAX_SAVED, newest first. Every read is checked, so a
// hand-edited or older entry is dropped instead of breaking the page.

export const SAVED_SEARCHES_KEY = 'advanced-search-saved'
export const MAX_SAVED = 50

export interface SavedSearch {
  id: string
  name: string
  query: string
  resources: string[]
  namespace: string
  createdAt: number
}

export type SavedSearchInput = Omit<SavedSearch, 'id' | 'createdAt'>

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalize(value: unknown): SavedSearch | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<SavedSearch>
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.query !== 'string' || typeof v.createdAt !== 'number') return null
  const name = v.name.trim()
  const query = v.query.trim()
  if (!name || !query) return null
  const resources = Array.isArray(v.resources) ? [...new Set(v.resources.filter((r): r is string => typeof r === 'string' && r !== ''))] : []
  return { id: v.id, name, query, resources, namespace: typeof v.namespace === 'string' ? v.namespace : '', createdAt: v.createdAt }
}

export function readSavedSearches(storage: Pick<Storage, 'getItem'> = localStorage): SavedSearch[] {
  try {
    const raw = storage.getItem(SAVED_SEARCHES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalize).filter((s): s is SavedSearch => s !== null).slice(0, MAX_SAVED)
  } catch {
    return []
  }
}

export function writeSavedSearches(searches: SavedSearch[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(searches.slice(0, MAX_SAVED)))
  } catch {
    // storage full or blocked: the list stays as it was on screen for this visit
  }
}

export function addSavedSearch(searches: SavedSearch[], input: SavedSearchInput, now = Date.now()): SavedSearch[] {
  const next = normalize({ ...input, id: newId(), createdAt: now })
  if (!next) return searches
  return [next, ...searches].slice(0, MAX_SAVED)
}

export function renameSavedSearch(searches: SavedSearch[], id: string, name: string): SavedSearch[] {
  const trimmed = name.trim()
  if (!trimmed) return searches
  return searches.map((s) => (s.id === id ? { ...s, name: trimmed } : s))
}

export function deleteSavedSearch(searches: SavedSearch[], id: string): SavedSearch[] {
  return searches.filter((s) => s.id !== id)
}
