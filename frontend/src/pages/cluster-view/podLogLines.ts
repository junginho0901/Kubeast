// The last line a followed log shows: its SSE id (k8s-service's "<UTC stamp>#<place among that stamp's lines>") and text.
export interface ShownLine {
  id: string
  text: string
}

// Order of two ids k8s-service wrote (fixed-width UTC stamps compare as text, places as numbers); null if either is not one.
function compareLogLineIds(a: string, b: string): number | null {
  const pa = /^(.+)#(\d+)$/.exec(a)
  const pb = /^(.+)#(\d+)$/.exec(b)
  if (!pa || !pb) return null
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1
  return Number(pa[2]) - Number(pb[2])
}

// The line to remember if this message is shown, or null for one the tab already shows (a server that started over).
export function takeLogLine(last: ShownLine | null, id: string, text: string): ShownLine | null {
  if (!id || !last?.id) return { id, text }
  const order = compareLogLineIds(id, last.id)
  if (order === null || order > 0) return { id, text }
  if (order < 0 || text === last.text) return null
  // EventSource gives a message without an id the last one it had: a server that sends none repeats it on new lines.
  return last
}
