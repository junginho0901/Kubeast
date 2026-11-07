import type { TFunction } from 'i18next'

import type { BulkRoleAnswer, BulkRoleFailure, Member } from '@/services/api'

// The route answers the list when everyone changed, and { updated, failed } with 207 when someone did not.
export function readBulkRoleAnswer(data: Member[] | BulkRoleAnswer): BulkRoleAnswer {
  return Array.isArray(data) ? { updated: data, failed: [] } : { updated: data.updated ?? [], failed: data.failed ?? [] }
}

// The accounts of a call that changed nobody (500); a refusal of the whole call (403) has none and its detail says why.
export function bulkRoleFailures(err: unknown): BulkRoleFailure[] {
  const failed = (err as { response?: { data?: { failed?: unknown } } } | null)?.response?.data?.failed
  return Array.isArray(failed) ? (failed as BulkRoleFailure[]) : []
}

function reasonText(t: TFunction, reason: BulkRoleFailure['reason']): string {
  switch (reason) {
    case 'not_found':
      return t('adminUsers.bulk.reasonNotFound', 'no such account')
    case 'self':
      return t('adminUsers.bulk.reasonSelf', 'your own account')
    default:
      return t('adminUsers.bulk.reasonFailed', 'the change failed, the audit log says why')
  }
}

export function bulkRoleFailureText(t: TFunction, total: number, failed: BulkRoleFailure[]): string {
  const accounts = failed.map((f) => `${f.email || f.user_id} (${reasonText(t, f.reason)})`).join(', ')
  return t('adminUsers.bulk.notChanged', {
    total,
    done: total - failed.length,
    accounts,
    defaultValue: '{{done}} of {{total}} accounts changed. Not changed: {{accounts}}',
  })
}
