// The identity an AI tool call reached its cluster as (services/pkg/auth.Access, sent on the tool result event)
// and its 🔐 line under the tool block's name. ai-service writes the same line into the saved answer
// (app/services/ai/access.py `line`); keep the two equal.

export interface ToolAccess {
  cluster?: string
  kind?: string
  api_key?: string
  user?: string
  groups?: string[]
  role?: string
  namespaces?: string[]
  impersonation?: boolean
  mode?: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

const code = (s: string) => `<code>${escapeHtml(s)}</code>`

export function accessLine(access: ToolAccess | null | undefined): string {
  if (!access || typeof access !== 'object') return ''
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const parts: string[] = []
  if (!access.impersonation) {
    parts.push("⚠️ Kubeast's own credential, not this user's permissions (impersonation is off)")
  } else {
    parts.push(code(String(access.user || '')) + (access.kind === 'api_key' ? ' (API key)' : ''))
    const groups = strings(access.groups)
    if (groups.length) parts.push('groups ' + groups.map(code).join(' '))
  }
  if (access.kind === 'investigator') {
    parts.push('alert investigator')
  } else if (access.kind === 'person' || access.kind === 'api_key') {
    const role = String(access.role || '')
    parts.push(role === '*' ? 'global admin' : role ? `role ${escapeHtml(role)}` : 'no role in this cluster')
    const namespaces = strings(access.namespaces)
    parts.push(namespaces.length ? 'namespaces ' + namespaces.map(escapeHtml).join(', ') : 'whole cluster')
  }
  parts.push(access.mode === 'write' ? 'write' : 'read-only')
  return `<p><strong>🔐 Ran as:</strong> ${parts.join(' · ')}</p>`
}
