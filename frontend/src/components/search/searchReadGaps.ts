// What a read of Advanced Search left out, as the toolbar's notices say it: the types whose list failed ("N failed", with
// each reason and, for a list that stopped on a later page, how many objects came first) and the types the server cut at
// the limit ("the first N only", of how many when the server counted them).
export interface SearchRead {
  errors: { type: string; error: string; loaded?: number }[]
  cut: { type: string; limit: number; remaining?: number }[]
}

// The same for the floating chat, beside the results: results over part of the objects are not told as complete.
export function searchReadGaps(read: Partial<SearchRead> | undefined): Record<string, unknown> {
  const errors = read?.errors ?? []
  const cut = read?.cut ?? []
  if (errors.length === 0 && cut.length === 0) return {}
  return {
    complete: false,
    failed_types: errors.length
      ? errors.map((e) => ({ type: e.type, reason: e.error, ...(e.loaded !== undefined ? { read_before_failure: e.loaded } : {}) }))
      : undefined,
    cut_types: cut.length
      ? cut.map((c) => ({ type: c.type, first: c.limit, ...(c.remaining ? { of: c.limit + c.remaining } : {}) }))
      : undefined,
  }
}

/** The gaps in a line of the layer's summary ("" when the read is whole). */
export function searchReadGapsText(read: Partial<SearchRead> | undefined): string {
  const errors = read?.errors ?? []
  const cut = read?.cut ?? []
  return `${errors.length ? ` · ${errors.length}개 종류 실패: ${errors.map((e) => e.type).join(', ')}` : ''}${
    cut.length ? ` · 처음 ${cut[0].limit}개만 읽은 종류: ${cut.map((c) => c.type).join(', ')}` : ''
  }`
}
