import type { HelmUpgradeResponse } from '@/services/api'

// What the Values tab hands the preview window when the dry run failed: there is no diff, and nothing to apply.
// `fallback` is said when the failure carries no reason (the screen's words for "dry-run failed").
export function failedPreview(err: any, fallback = 'dry-run failed'): HelmUpgradeResponse {
  return {
    dryRun: true,
    fromRevision: 0,
    chartVersion: '',
    failed: String(err?.response?.data?.detail ?? err?.message ?? fallback),
  }
}
