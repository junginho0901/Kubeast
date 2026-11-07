import type { TFunction } from 'i18next'

import type { BulkCreateAnswer, BulkCreateFailure } from '@/services/api'

export interface BulkCsvUser {
  name: string
  email: string
  password: string
  role_id: number
  team?: string
}

export interface ParsedBulkCsv {
  users: BulkCsvUser[]
  /** rows that cannot be sent, said beside the server's answer instead of vanishing */
  failed: BulkCreateFailure[]
}

// The rows of the template's CSV. A role id of 0 would make the server pick Member, so a role not found stays here.
export function parseBulkCsv(text: string, roles: Array<{ id: number; name: string }>): ParsedBulkCsv {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const parsed: ParsedBulkCsv = { users: [], failed: [] }
  for (const line of lines.slice(1)) {
    const [name = '', email = '', password = '', roleColumn = '', team = ''] = line.split(',').map((c) => c.trim())
    const roleName = roleColumn || 'read'
    const role = roles.find((r) => r.name === roleName)
    if (!name || !email || !password) {
      parsed.failed.push({ email, reason: 'missing_fields' })
    } else if (!role) {
      parsed.failed.push({ email, reason: 'role', detail: roleName })
    } else {
      parsed.users.push({ name, email, password, role_id: role.id, team: team || undefined })
    }
  }
  return parsed
}

// The lists of a bulk creation's answer, which an older server wrote as null when empty.
export function readBulkCreateAnswer(data: { created?: BulkCreateAnswer['created'] | null; failed?: BulkCreateFailure[] | null }): BulkCreateAnswer {
  return { created: data.created ?? [], failed: data.failed ?? [] }
}

// The accounts of a call a failed write left empty (500); a refusal of the whole call (403) has none and its detail says why.
export function bulkCreateFailures(err: unknown): BulkCreateFailure[] {
  const failed = (err as { response?: { data?: { failed?: unknown } } } | null)?.response?.data?.failed
  return Array.isArray(failed) ? (failed as BulkCreateFailure[]) : []
}

function reasonText(t: TFunction, reason: BulkCreateFailure['reason']): string {
  switch (reason) {
    case 'missing_fields':
      return t('adminUsers.bulkFailure.missingFields', 'name, email and password are required')
    case 'name':
      return t('adminUsers.bulkFailure.name', 'this name cannot be a Kubernetes user: no colon, space or control character')
    case 'password':
      return t('adminUsers.bulkFailure.password', 'the password does not meet the policy')
    case 'role':
      return t('adminUsers.bulkFailure.role', 'no such role')
    case 'ceiling':
      return t('adminUsers.bulkFailure.ceiling', 'the role gives permissions you do not hold')
    case 'team':
      return t('adminUsers.bulkFailure.team', 'no such team')
    case 'exists':
      return t('adminUsers.bulkFailure.exists', 'this email already has an account')
    default:
      return t('adminUsers.bulkFailure.failed', 'the creation failed, the audit log says why')
  }
}

// One line per account left out, with why.
export function bulkCreateFailureRows(t: TFunction, failed: BulkCreateFailure[]): string[] {
  return failed.map((f) => `${f.email || '-'}: ${reasonText(t, f.reason)}${f.detail ? `: ${f.detail}` : ''}`)
}

export function bulkCreateSummary(t: TFunction, total: number, failed: number): string {
  return t('adminUsers.bulkNotCreated', { total, failed, defaultValue: 'Not created: {{failed}} of {{total}} accounts' })
}
