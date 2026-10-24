// The identity an AI tool call reached its cluster as (services/pkg/auth.Access) and the cluster requests it made
// (services/pkg/accesstrail), both sent on the tool result event, and what goes under the tool block's name. ai-service
// writes the same into the saved answer (app/services/ai/access.py `section`); keep the two equal.

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

// One cluster request of a call (services/pkg/accesstrail), or an answer from Kubeast's own store.
export interface ToolRequest {
  source?: string
  verb?: string
  group?: string
  resource?: string
  subresource?: string
  namespace?: string
  name?: string
  path?: string
  status?: number
  audit_id?: string
  echoed?: boolean
  cache?: string
}

export interface ToolRequests {
  requests: ToolRequest[]
  total: number
}

function requestText(r: ToolRequest): string {
  if (r.source === 'cache') return `answered from Kubeast's own store (${escapeHtml(String(r.cache || ''))}), no cluster request`
  const verb = escapeHtml(String(r.verb || ''))
  let what: string
  if (r.resource) {
    what = escapeHtml([r.group, r.resource, r.subresource].filter(Boolean).join('/')) + (r.name ? ` ${escapeHtml(String(r.name))}` : '')
  } else {
    what = escapeHtml(String(r.path || ''))
  }
  const where = r.namespace ? ` in ${escapeHtml(String(r.namespace))}` : ''
  const status = typeof r.status === 'number' && r.status ? ` → ${r.status}` : ' → no answer'
  const audit = r.audit_id ? ` · Audit-ID ${code(String(r.audit_id))}` + (r.echoed ? ' ✓' : ' (not echoed)') : ''
  return `${verb} ${what}${where}${status}${audit}`
}

// The folded list of a call's cluster requests under its 🔐 line (ai-service access.requests_block).
export function requestsBlock(value: ToolRequests | null | undefined): string {
  if (!value || !Array.isArray(value.requests) || typeof value.total !== 'number' || value.total <= 0) return ''
  const shown = value.requests.slice(0, 20)
  const items = shown.map((r) => `<li>${requestText(r)}</li>`)
  if (value.total > shown.length) items.push(`<li>and ${value.total - shown.length} more</li>`)
  return `<details>\n<summary><strong>🧾 Cluster requests (${value.total})</strong></summary>\n\n<ul>\n${items.join('\n')}\n</ul>\n\n</details>`
}

// What goes under a tool block's name: the 🔐 line, then the requests (ai-service access.section).
export function accessSection(access: ToolAccess | null | undefined, requests: ToolRequests | null | undefined): string {
  return [accessLine(access), requestsBlock(requests)].filter(Boolean).join('\n\n')
}
