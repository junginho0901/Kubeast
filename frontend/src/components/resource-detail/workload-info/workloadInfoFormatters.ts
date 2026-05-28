export function boolText(value: unknown): string {
  return value ? 'Yes' : 'No'
}

export function formatContainerCommand(command: unknown, args: unknown): string {
  const cmd = Array.isArray(command) ? command : []
  const argv = Array.isArray(args) ? args : []
  const merged = [...cmd, ...argv].filter(Boolean)
  return merged.length > 0 ? merged.join(' ') : '-'
}

export function toEntryPairs(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)])
}

export function toPorts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((p: any) => `${p?.container_port ?? p?.containerPort ?? '-'} / ${p?.protocol || 'TCP'}`)
    .filter((v: string) => v.trim() !== '- / TCP')
}

export function toMounts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((m: any) => `${m?.name || '-'} -> ${m?.mount_path ?? m?.mountPath ?? '-'}`)
    .filter((v: string) => v.trim() !== '- -> -')
}

export function formatToleration(tol: any): string {
  const key = tol?.key || '*'
  const operator = tol?.operator || 'Equal'
  const value = tol?.value || ''
  const effect = tol?.effect || ''
  const seconds = tol?.toleration_seconds ?? tol?.tolerationSeconds
  return `${key} ${operator} ${value} ${effect}${seconds != null ? ` (${seconds}s)` : ''}`.trim()
}

export function formatProbe(probe: any): string {
  if (!probe || typeof probe !== 'object') return ''
  const parts: string[] = []

  if (probe.httpGet) {
    const h = probe.httpGet
    parts.push(`httpGet ${h.scheme ?? 'HTTP'}://:${h.port ?? '?'}${h.path ?? '/'}`)
  } else if (probe.tcpSocket) {
    parts.push(`tcpSocket :${probe.tcpSocket.port ?? '?'}`)
  } else if (probe.exec) {
    const cmd = Array.isArray(probe.exec.command) ? probe.exec.command.join(' ') : ''
    parts.push(`exec [${cmd}]`)
  } else if (probe.grpc) {
    parts.push(`grpc :${probe.grpc.port ?? '?'}${probe.grpc.service ? ` svc=${probe.grpc.service}` : ''}`)
  }

  const timings: string[] = []
  if (probe.initialDelaySeconds != null) timings.push(`delay=${probe.initialDelaySeconds}s`)
  if (probe.periodSeconds != null) timings.push(`period=${probe.periodSeconds}s`)
  if (probe.timeoutSeconds != null) timings.push(`timeout=${probe.timeoutSeconds}s`)
  if (probe.successThreshold != null) timings.push(`success=${probe.successThreshold}`)
  if (probe.failureThreshold != null) timings.push(`failure=${probe.failureThreshold}`)
  if (timings.length > 0) parts.push(timings.join(' '))

  return parts.join(' | ')
}

export function formatCapabilities(caps: any): string {
  if (!caps || typeof caps !== 'object') return ''
  const parts: string[] = []
  if (Array.isArray(caps.add) && caps.add.length > 0) parts.push(`add: ${caps.add.join(', ')}`)
  if (Array.isArray(caps.drop) && caps.drop.length > 0) parts.push(`drop: ${caps.drop.join(', ')}`)
  return parts.join(' | ')
}

export function formatLabelSelector(sel: any): string {
  if (!sel || typeof sel !== 'object') return '-'
  const parts: string[] = []
  if (sel.matchLabels && typeof sel.matchLabels === 'object') {
    Object.entries(sel.matchLabels).forEach(([k, v]) => parts.push(`${k}=${v}`))
  }
  if (Array.isArray(sel.matchExpressions)) {
    sel.matchExpressions.forEach((expr: any) => {
      const vals = Array.isArray(expr.values) ? expr.values.join(', ') : ''
      parts.push(`${expr.key || '?'} ${expr.operator || '?'} [${vals}]`)
    })
  }
  return parts.length > 0 ? parts.join(', ') : '-'
}
