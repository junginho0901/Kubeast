// Kubernetes quantities for the resize dialog: a CPU as millicores and a memory
// size as MiB, both ways. Only the units the resize API takes are covered.
// quantityValue reads every unit, for ratios such as a quota's used over hard.

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

const SUFFIXES: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
}

// Any quantity as apimachinery's resource.Quantity reads it, in base units (cores, bytes, a count): "250m" is 0.25,
// "1k" 1000, "1e3" 1000. Null for anything Kubernetes would not take.
export function quantityValue(q?: string | number | null): number | null {
  if (q === undefined || q === null || q === '') return null
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE])?)$/.exec(String(q).trim())
  if (!m) return null
  const n = m[2] ? Number(m[1] + m[2]) : Number(m[1]) * SUFFIXES[m[3] ?? '']
  return Number.isFinite(n) ? n : null
}

// A quota's used over hard in percent: "207m" of "1" is 21.
export function quotaPercent(used?: string | null, hard?: string | null): number | null {
  const u = quantityValue(used)
  const h = quantityValue(hard)
  if (u === null || h === null || h === 0) return null
  return Math.round((u / h) * 100)
}

export function bytesToMiB(bytes?: number | null): number | null {
  if (bytes === undefined || bytes === null) return null
  return Math.round(bytes / 1024 ** 2)
}
