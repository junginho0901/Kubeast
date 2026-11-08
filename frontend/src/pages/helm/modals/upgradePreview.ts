import type { HelmUpgradeResponse } from '@/services/api'

// What the Values tab hands the preview window when the dry run failed: there is no diff, and nothing to apply.
export function failedPreview(err: any): HelmUpgradeResponse {
  return {
    dryRun: true,
    fromRevision: 0,
    chartVersion: '',
    failed: String(err?.response?.data?.detail ?? err?.message ?? 'dry-run failed'),
  }
}
