// The VPA drawer's words for the fields of VPA 1.6 and 1.7 (vertical-pod-autoscaler-1.8.1's vpa-v1-crd-gen.yaml), as
// the server's row (internal/vpa) passes them on: numbers and quantities as written, "-" when left out.

export function vpaValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

const BOOST_ORDER = ['type', 'factor', 'quantity', 'durationSeconds']

// startupBoost: per resource its policy, the API's field names in its order — "cpu (type: Factor, factor: 2, durationSeconds: 10)"
export function vpaStartupBoostText(boost: unknown): string {
  if (!boost || typeof boost !== 'object' || Array.isArray(boost)) return '-'
  const parts = Object.keys(boost).sort().map((resource) => {
    const policy = (boost as Record<string, unknown>)[resource]
    if (!policy || typeof policy !== 'object') return `${resource} (${vpaValue(policy)})`
    const keys = Object.keys(policy).sort((a, b) => {
      const [i, j] = [BOOST_ORDER.indexOf(a), BOOST_ORDER.indexOf(b)]
      return (i < 0 ? BOOST_ORDER.length : i) - (j < 0 ? BOOST_ORDER.length : j) || a.localeCompare(b)
    })
    return `${resource} (${keys.map((k) => `${k}: ${vpaValue((policy as Record<string, unknown>)[k])}`).join(', ')})`
  })
  return parts.length ? parts.join('; ') : '-'
}

// A container policy's OOM, memory aggregation and startup boost fields: one row per policy, or none when no policy
// sets any of them (the table is not drawn, as the policies' own table without policies).
export const VPA_POLICY_EXTRA_HEAD = ['Container', 'OOM Bump Up Ratio', 'OOM Min Bump Up', 'Memory Aggregation Interval Seconds', 'Memory Aggregation Interval Count', 'Startup Boost']
const EXTRA_KEYS = ['oom_bump_up_ratio', 'oom_min_bump_up', 'memory_aggregation_interval_seconds', 'memory_aggregation_interval_count', 'startup_boost']

export function vpaPolicyExtraRows(policies: Record<string, unknown>[]): string[][] {
  if (!policies.some((p) => EXTRA_KEYS.some((k) => p[k] !== undefined && p[k] !== null))) return []
  return policies.map((p) => [
    vpaValue(p.container_name),
    vpaValue(p.oom_bump_up_ratio),
    vpaValue(p.oom_min_bump_up),
    vpaValue(p.memory_aggregation_interval_seconds),
    vpaValue(p.memory_aggregation_interval_count),
    vpaStartupBoostText(p.startup_boost),
  ])
}
