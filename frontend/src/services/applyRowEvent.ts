// One frame of a list's watch applied to its rows. The server sends the list's whole row, so it takes the old one's place,
// where a value that went away shows that instead of the old one.
export function applyRowEvent<T extends { name: string; namespace?: string | null }>(
  prev: T[] | undefined,
  event: { type?: string; object?: any },
  normalize: (obj: any) => T,
): T[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const row = normalize(obj)
  if (!row?.name) return items

  const index = items.findIndex((item) => item.name === row.name && (item.namespace ?? '') === (row.namespace ?? ''))

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = row
  else items.push(row)

  return items
}
