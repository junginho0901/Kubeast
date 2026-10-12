// Kubernetes quantities for the resize dialog: a CPU as millicores and a memory
// size as MiB, both ways. Only the units the resize API takes are covered.

export function cpuToMillis(q?: string | number | null): number | null {
  if (q === undefined || q === null || q === '') return null
  const s = String(q).trim()
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1))
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 1000) : null
}

const MEM_UNITS: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 }

export function memoryToBytes(q?: string | number | null): number | null {
  if (q === undefined || q === null || q === '') return null
  const s = String(q).trim()
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(s)
  if (!m) return null
  const n = Number(m[1]) * (m[2] ? MEM_UNITS[m[2]] : 1)
  return Number.isFinite(n) ? Math.round(n) : null
}

export function bytesToMiB(bytes?: number | null): number | null {
  if (bytes === undefined || bytes === null) return null
  return Math.round(bytes / 1024 ** 2)
}
