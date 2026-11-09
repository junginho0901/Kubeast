// The Pending window's selection, kept by account id so it stays while another page of the window is shown. The
// header box stands for every pending account on every page.

export function allPendingSelected(selected: ReadonlySet<string>, pendingIds: readonly string[]): boolean {
  return pendingIds.length > 0 && pendingIds.every((id) => selected.has(id))
}

export function toggleAllPending(selected: ReadonlySet<string>, pendingIds: readonly string[]): Set<string> {
  return allPendingSelected(selected, pendingIds) ? new Set() : new Set(pendingIds)
}

export function toggleOnePending(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
