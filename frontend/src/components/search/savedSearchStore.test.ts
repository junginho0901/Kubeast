import { describe, expect, it } from 'vitest'
import { MAX_SAVED, SAVED_SEARCHES_KEY, addSavedSearch, deleteSavedSearch, readSavedSearches, renameSavedSearch, writeSavedSearches, type SavedSearch } from './savedSearchStore'

function memory(initial?: string) {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set(SAVED_SEARCHES_KEY, initial)
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

const input = { name: ' failing pods ', query: " status.phase === 'Failed' ", resources: ['pods', 'pods', ''], namespace: 'shop' }

describe('saved searches', () => {
  it('adds newest first with the name and query trimmed and the resources without repeats', () => {
    const one = addSavedSearch([], input, 1)
    const two = addSavedSearch(one, { ...input, name: 'second' }, 2)
    expect(two.map((s) => s.name)).toEqual(['second', 'failing pods'])
    expect(two[1]).toMatchObject({ query: "status.phase === 'Failed'", resources: ['pods'], namespace: 'shop', createdAt: 1 })
  })

  it('refuses an empty name or query and keeps at most MAX_SAVED', () => {
    expect(addSavedSearch([], { ...input, name: '  ' })).toEqual([])
    expect(addSavedSearch([], { ...input, query: '' })).toEqual([])
    let list: SavedSearch[] = []
    for (let i = 0; i < MAX_SAVED + 5; i++) list = addSavedSearch(list, { ...input, name: `q${i}` }, i)
    expect(list).toHaveLength(MAX_SAVED)
    expect(list[0].name).toBe(`q${MAX_SAVED + 4}`)
  })

  it('renames and deletes by id; a blank new name changes nothing', () => {
    const list = addSavedSearch([], input, 1)
    const id = list[0].id
    expect(renameSavedSearch(list, id, ' new name ')[0].name).toBe('new name')
    expect(renameSavedSearch(list, id, ' ')).toBe(list)
    expect(deleteSavedSearch(list, id)).toEqual([])
  })

  it('reads back what it wrote and drops what is not a saved search', () => {
    const store = memory()
    writeSavedSearches(addSavedSearch([], input, 1), store)
    expect(readSavedSearches(store)).toHaveLength(1)
    expect(readSavedSearches(memory('not json'))).toEqual([])
    expect(readSavedSearches(memory('{"a":1}'))).toEqual([])
    expect(readSavedSearches(memory(JSON.stringify([{ id: 'x', name: 'n', query: 'q', createdAt: 1, resources: 'pods' }, { id: 1 }])))).toEqual([
      { id: 'x', name: 'n', query: 'q', resources: [], namespace: '', createdAt: 1 },
    ])
  })
})
