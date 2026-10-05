import type { APIKey } from '@/services/api/api_keys'

// Shared by the account section and the admin user modal (kept out of the
// component files so fast refresh keeps working).
export function formatScope(key: APIKey, allLabel: string): string {
  return key.cluster_ids && key.cluster_ids.length > 0 ? key.cluster_ids.join(', ') : allLabel
}
