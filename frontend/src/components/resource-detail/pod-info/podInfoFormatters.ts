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
  // backend 는 snake_case (read_only_root_filesystem) 로, raw spec 은 camelCase 로
  // 보내므로 둘 다 받는다.
  const get = (camel: string, snake: string) => sc[camel] ?? sc[snake]
  const rows: Array<[string, string]> = []
  if (sc.privileged != null) rows.push(['Privileged', String(sc.privileged)])
  if (get('runAsUser', 'run_as_user') != null) rows.push(['Run As User', String(get('runAsUser', 'run_as_user'))])
  if (get('runAsGroup', 'run_as_group') != null) rows.push(['Run As Group', String(get('runAsGroup', 'run_as_group'))])
  if (get('runAsNonRoot', 'run_as_non_root') != null) rows.push(['Run As Non-Root', String(get('runAsNonRoot', 'run_as_non_root'))])
  if (get('readOnlyRootFilesystem', 'read_only_root_filesystem') != null)
    rows.push(['Read-Only Root FS', String(get('readOnlyRootFilesystem', 'read_only_root_filesystem'))])
  if (get('allowPrivilegeEscalation', 'allow_privilege_escalation') != null)
    rows.push(['Allow Privilege Escalation', String(get('allowPrivilegeEscalation', 'allow_privilege_escalation'))])
  if (sc.capabilities) {
    if (Array.isArray(sc.capabilities.add) && sc.capabilities.add.length > 0)
      rows.push(['Capabilities (add)', sc.capabilities.add.join(', ')])
    if (Array.isArray(sc.capabilities.drop) && sc.capabilities.drop.length > 0)
      rows.push(['Capabilities (drop)', sc.capabilities.drop.join(', ')])
  }
  return rows
}

// envFrom — Pod 가 ConfigMap / Secret 통째로 환경변수로 가져오는 출처.
// backend: container.env_from = [{config_map?, secret?, prefix?, optional?}]
// raw spec: container.envFrom = [{configMapRef?, secretRef?, prefix?}]
export interface EnvFromEntry {
  kind: 'ConfigMap' | 'Secret'
  name: string
  prefix?: string
  optional?: boolean
}

export function normalizeEnvFrom(c: any): EnvFromEntry[] {
  const result: EnvFromEntry[] = []
  // backend snake_case 형식
  if (Array.isArray(c.env_from)) {
    for (const ef of c.env_from) {
      if (ef.config_map) result.push({ kind: 'ConfigMap', name: ef.config_map, prefix: ef.prefix, optional: ef.optional })
      else if (ef.secret) result.push({ kind: 'Secret', name: ef.secret, prefix: ef.prefix, optional: ef.optional })
    }
    return result
  }
  // raw spec camelCase
  if (Array.isArray(c.envFrom)) {
    for (const ef of c.envFrom) {
      if (ef.configMapRef?.name) result.push({ kind: 'ConfigMap', name: ef.configMapRef.name, prefix: ef.prefix, optional: ef.configMapRef.optional })
      else if (ef.secretRef?.name) result.push({ kind: 'Secret', name: ef.secretRef.name, prefix: ef.prefix, optional: ef.secretRef.optional })
    }
  }
  return result
}
