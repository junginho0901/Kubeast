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

// The columns the template writes, the upload window names and parseBulkCsv reads, in that order.
export const BULK_CSV_HEADER = 'name,email,password,role,team'

// What the server makes an account with no role named: a global Read or Write has no effect, so no example offers one.
const DEFAULT_ROLE = 'Member'

// The example row goes up as it is, so a password all templates shared would be an account anyone could sign in to.
export function exampleBulkPassword(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function bulkCsvTemplate(teamNames: string[], roles: Array<{ name: string }>, password: string): string {
  const levels = roles.filter((r) => ['Admin', 'Member'].includes(r.name)).map((r) => r.name).join(', ') || 'Admin, Member'
  return [
    `# Available Team: ${teamNames.length > 0 ? teamNames.join(', ') : '(none registered)'}`,
    `# role (account level): ${levels}`,
    BULK_CSV_HEADER,
    // the server refuses a team it does not have, so with none registered the column stays empty
    `Hong Gildong,hong@example.com,${password},${DEFAULT_ROLE},${teamNames[0] ?? ''}`,
    '',
  ].join('\n')
}

// The rows of the template's CSV. A role id of 0 would make the server pick Member, so a role not found stays here.
// A name is read as written: names that differ in capitals can both be stored, and a role decides what an account may do.
export function parseBulkCsv(text: string, roles: Array<{ id: number; name: string }>): ParsedBulkCsv {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const parsed: ParsedBulkCsv = { users: [], failed: [] }
  for (const line of lines.slice(1)) {
    const [name = '', email = '', password = '', roleColumn = '', team = ''] = line.split(',').map((c) => c.trim())
    const roleName = roleColumn || DEFAULT_ROLE
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
