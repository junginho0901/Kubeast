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
    .map((p: any) => `${p?.containerPort ?? p?.container_port ?? '-'} / ${p?.protocol || 'TCP'}`)
    .filter((v: string) => v.trim() !== '- / TCP')
}

export function toMounts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((m: any) => `${m?.name || '-'} -> ${m?.mountPath ?? m?.mount_path ?? '-'}`)
    .filter((v: string) => v.trim() !== '- -> -')
}

export function formatProbe(probe: any): string | null {
  if (!probe) return null
  const parts: string[] = []
  if (probe.httpGet) {
    parts.push(`httpGet ${probe.httpGet.path || '/'}:${probe.httpGet.port ?? '-'}`)
  } else if (probe.tcpSocket) {
    parts.push(`tcpSocket :${probe.tcpSocket.port ?? '-'}`)
  } else if (probe.exec) {
    parts.push(`exec [${Array.isArray(probe.exec.command) ? probe.exec.command.join(' ') : '-'}]`)
  } else if (probe.grpc) {
    parts.push(`grpc :${probe.grpc.port ?? '-'}`)
  }
  const timing: string[] = []
  if (probe.initialDelaySeconds != null) timing.push(`delay=${probe.initialDelaySeconds}s`)
  if (probe.periodSeconds != null) timing.push(`period=${probe.periodSeconds}s`)
  if (probe.timeoutSeconds != null) timing.push(`timeout=${probe.timeoutSeconds}s`)
  if (probe.successThreshold != null) timing.push(`success=${probe.successThreshold}`)
  if (probe.failureThreshold != null) timing.push(`failure=${probe.failureThreshold}`)
  if (timing.length > 0) parts.push(timing.join(' '))
  return parts.join(' | ')
}

export function getVolumeDetail(v: any): { type: string; detail: string } {
  if (v.configMap) return { type: 'ConfigMap', detail: v.configMap.name || '-' }
  if (v.secret) return { type: 'Secret', detail: v.secret.secretName || '-' }
  if (v.persistentVolumeClaim) {
    const pvc = v.persistentVolumeClaim
    return { type: 'PVC', detail: `${pvc.claimName || '-'}${pvc.readOnly ? ' (ro)' : ''}` }
  }
  if (v.emptyDir) {
    const parts: string[] = []
    if (v.emptyDir.medium) parts.push(`medium=${v.emptyDir.medium}`)
    if (v.emptyDir.sizeLimit) parts.push(`limit=${v.emptyDir.sizeLimit}`)
    return { type: 'EmptyDir', detail: parts.length > 0 ? parts.join(', ') : '(default)' }
  }
  if (v.hostPath) {
    return { type: 'HostPath', detail: `${v.hostPath.path || '-'}${v.hostPath.type ? ` (${v.hostPath.type})` : ''}` }
  }
  if (v.projected) {
    const srcs = Array.isArray(v.projected.sources)
      ? v.projected.sources.map((s: any) => Object.keys(s).join(',')).join('; ')
      : '-'
    return { type: 'Projected', detail: srcs }
  }
  if (v.downwardAPI) return { type: 'DownwardAPI', detail: 'Downward API' }
  const type = Object.keys(v).find(k => k !== 'name') || 'unknown'
  return { type, detail: '-' }
}

export function formatContainerSecurityContext(sc: any): Array<[string, string]> {
  if (!sc) return []
  const rows: Array<[string, string]> = []
  if (sc.privileged != null) rows.push(['Privileged', String(sc.privileged)])
  if (sc.runAsUser != null) rows.push(['Run As User', String(sc.runAsUser)])
  if (sc.runAsNonRoot != null) rows.push(['Run As Non-Root', String(sc.runAsNonRoot)])
  if (sc.readOnlyRootFilesystem != null) rows.push(['Read-Only Root FS', String(sc.readOnlyRootFilesystem)])
  if (sc.allowPrivilegeEscalation != null) rows.push(['Allow Privilege Escalation', String(sc.allowPrivilegeEscalation)])
  if (sc.capabilities) {
    if (Array.isArray(sc.capabilities.add) && sc.capabilities.add.length > 0)
      rows.push(['Capabilities (add)', sc.capabilities.add.join(', ')])
    if (Array.isArray(sc.capabilities.drop) && sc.capabilities.drop.length > 0)
      rows.push(['Capabilities (drop)', sc.capabilities.drop.join(', ')])
  }
  return rows
}
