// ResourceDetailDrawer 의 유틸 + 상수.
// ResourceDetailDrawer.tsx 에서 추출 (Phase 3.3.a).
//
// 모두 순수 / 표현 컴포넌트라 instance state 없음. drawer 본체에서 import.
//
// 분류:
// - 상수: WORKLOAD_KINDS / NETWORK_KINDS / CONFIG_STORAGE_KINDS / SELF_LOADING_KINDS / UNRESOLVABLE_KINDS
// - 매핑: kindToPlural (Kind → API 복수형) — Kind 아이콘은 components/kindIcons.ts(사이드바와 공용)
// - Helm: extractHelmRelease (배지 컴포넌트는 HelmReleaseBadge.tsx)
// - Secret: decodeSecretYaml / encodeSecretYaml (data ↔ stringData base64 변환)

import type { YamlOpened } from '@/services/api/types'

export type TabId = 'info' | 'yaml'

export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'])
export const NETWORK_KINDS = new Set(['Ingress', 'IngressClass', 'NetworkPolicy', 'Endpoints', 'EndpointSlice'])
export const CONFIG_STORAGE_KINDS = new Set(['PersistentVolume', 'PersistentVolumeClaim', 'StorageClass', 'VolumeAttachment'])

// Kinds whose info components fetch their own data and don't need injected rawJson.
export const SELF_LOADING_KINDS = new Set(['Node', 'Namespace'])
// CustomResourceInstance needs crd_name in rawJson and cannot be resolved via kindToPlural.
export const UNRESOLVABLE_KINDS = new Set(['CustomResourceInstance'])

// extractHelmRelease returns the owning Helm release coordinates
// (namespace, name) if the given raw resource JSON carries the
// meta.helm.sh annotations. The managed-by label is an extra signal
// but we do not require it — Helm sets the annotations even when a
// chart intentionally omits the label.
export function extractHelmRelease(
  rawJson: Record<string, unknown> | null | undefined,
): { namespace: string; name: string } | null {
  const metadata = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const name = annotations['meta.helm.sh/release-name']
  const ns = annotations['meta.helm.sh/release-namespace']
  if (typeof name !== 'string' || !name) return null
  if (typeof ns !== 'string' || !ns) return null
  return { namespace: ns, name }
}

// data ↔ stringData: the window shows a value's letters and saves the same bytes. The lines are read one by one, not parsed:
// the rest of the object stays as written, for the server's parser.
const BINARY_TAG = '!!binary'
const BLOCK_HEADER = /^([|>])([-+]?[1-9]?|[1-9][-+]?)\s*(?:#.*)?$/
// Letters an editor would hide or take for a line ending: written as escapes.
const staysEscaped = (c: string) => {
  const code = c.charCodeAt(0)
  return (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
// An empty value written as nothing would read as null, which removes the key from a merge patch.
const encodedText = (text: string) => (text === '' ? '""' : toBase64(new TextEncoder().encode(text)))

// A value's letters; null for what no text holds as it is: bytes that are not UTF-8, or control characters other than \t \n \v \f \r.
function lettersOf(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
  const control = Array.from(text).some((c) => {
    const code = c.charCodeAt(0)
    return code <= 0x08 || (code >= 0x0e && code <= 0x1f)
  })
  return control ? null : text
}

// Whether the window can show the letters without quotes: savedText reads them back as they are.
function readsPlainly(text: string): boolean {
  if (text === '' || text !== text.trim() || /[:#"']/.test(text) || text.startsWith(BINARY_TAG) || BLOCK_HEADER.test(text)) return false
  return !Array.from(text).some((c) => c.charCodeAt(0) < 0x20 || staysEscaped(c))
}

// What the window shows for a value of data; null for a line that is no base64, which it leaves as the server sent it (the mask, "").
function shownValue(base64: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = fromBase64(base64)
  } catch {
    return null
  }
  const text = toBase64(bytes) === base64 ? lettersOf(bytes) : null
  if (text === null) return `${BINARY_TAG} ${base64}`
  if (readsPlainly(text)) return text
  return Array.from(JSON.stringify(text), (c) => (staysEscaped(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')
}

export function decodeSecretYaml(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  let inDataBlock = false
  let dataIndent = -1
  for (const line of lines) {
    if (/^data:\s*$/.test(line)) {
      result.push('stringData:')
      inDataBlock = true
      dataIndent = -1
      continue
    }
    if (inDataBlock) {
      const match = line.match(/^(\s+)(\S+?):\s*(.+)$/)
      if (match) {
        const [, indent, key, value] = match
        if (dataIndent < 0) dataIndent = indent.length
        if (indent.length === dataIndent) {
          const shown = shownValue(value.trim())
          result.push(shown === null ? line : `${indent}${key}: ${shown}`)
          continue
        }
      }
      if (line.length > 0 && !line.startsWith(' ')) {
        inDataBlock = false
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:\s+#.*)?$/
const BINARY_VALUE = /^!!binary\s+(\S+)(?:\s+#.*)?$/
const YAML_ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
  '"': '"', '/': '/', '\\': '\\', N: String.fromCharCode(0x85), _: String.fromCharCode(0xa0), L: String.fromCharCode(0x2028), P: String.fromCharCode(0x2029),
}
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 }

// The letters between double quotes, as YAML reads them; null for an escape it does not have.
function doubleQuotedText(body: string): string | null {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i]
      continue
    }
    const escape = body[++i]
    const width = HEX_ESCAPES[escape]
    if (width) {
      const digits = body.slice(i + 1, i + 1 + width)
      const code = /^[0-9a-fA-F]+$/.test(digits) && digits.length === width ? parseInt(digits, 16) : -1
      if (code < 0 || code > 0x10ffff) return null
      out += String.fromCodePoint(code)
      i += width
    } else if (escape in YAML_ESCAPES) {
      out += YAML_ESCAPES[escape]
    } else {
      return null
    }
  }
  return out
}

// The value a line of one line says. Quotes and a comment as YAML reads them; anything else is the word typed: a password
// like !abc or #abc is what its author meant, and read as YAML would be an empty value.
function savedText(raw: string): string {
  const double = raw.match(DOUBLE_QUOTED)
  if (double) return doubleQuotedText(double[1]) ?? raw
  const single = raw.match(SINGLE_QUOTED)
  if (single) return single[1].replace(/''/g, "'")
  return raw.replace(/\s+#.*$/, '')
}

function foldedText(lines: string[]): string {
  let out = ''
  let blanks = 0
  let afterDeeper = false
  lines.forEach((line, i) => {
    if (line === '') {
      blanks++
      return
    }
    const deeper = /^[ \t]/.test(line)
    if (i > blanks) out += deeper || afterDeeper ? '\n'.repeat(blanks + 1) : blanks > 0 ? '\n'.repeat(blanks) : ' '
    else out += '\n'.repeat(blanks)
    out += line
    blanks = 0
    afterDeeper = deeper
  })
  return out
}

// A block value (key: |) from the lines below its key, as YAML reads it; end is the first line after it.
function blockValue(lines: string[], start: number, keyIndent: number, header: RegExpMatchArray): { text: string; end: number } {
  let end = start
  while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > keyIndent)) end++
  // the last empty string of a text ending in a line break is that break, no line of the block
  const endsTheText = end === lines.length
  const finalBreak = !endsTheText || (end > start && lines[end - 1] === '')
  if (endsTheText && finalBreak) end--
  const body = lines.slice(start, end)
  const digit = header[2].replace(/[-+]/, '')
  const first = body.find((line) => line.trim() !== '')
  const indent = digit ? keyIndent + Number(digit) : first ? first.search(/\S/) : 0
  const texts = body.map((line) => (line.trim() === '' && line.length <= indent ? '' : line.slice(indent)))
  let last = texts.length
  while (last > 0 && texts[last - 1] === '') last--
  const trailing = texts.length - last
  const content = header[1] === '|' ? texts.slice(0, last).join('\n') : foldedText(texts.slice(0, last))
  if (header[2].includes('-')) return { text: content, end }
  const breaks = '\n'.repeat(trailing)
  if (header[2].includes('+')) return { text: last > 0 ? `${content}\n${breaks}` : breaks, end }
  return { text: last > 0 && (trailing > 0 || finalBreak) ? `${content}\n` : content, end }
}

export function encodeSecretYaml(yaml: string): string {
  const lines = yaml.split('\n')
  const result: string[] = []
  let inStringDataBlock = false
  let blockIndent = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^stringData:\s*$/.test(line)) {
      result.push('data:')
      inStringDataBlock = true
      blockIndent = -1
      continue
    }
    if (inStringDataBlock) {
      const match = line.match(/^(\s+)(\S+?):\s*([^\n]*)$/)
      if (match) {
        const [, indent, key, value] = match
        if (blockIndent < 0) blockIndent = indent.length
        if (indent.length === blockIndent) {
          const raw = value.trim()
          const header = raw.match(BLOCK_HEADER)
          const binary = raw.match(BINARY_VALUE)
          if (header) {
            const block = blockValue(lines, i + 1, indent.length, header)
            result.push(`${indent}${key}: ${encodedText(block.text)}`)
            i = block.end - 1
          } else if (raw === '') {
            // no value: null, which takes the key out of a merge patch
            result.push(line)
          } else {
            result.push(`${indent}${key}: ${binary ? binary[1] : encodedText(savedText(raw))}`)
          }
          continue
        }
      }
      if (line.length > 0 && !line.startsWith(' ')) {
        inStringDataBlock = false
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

// What a save sends of the text its edit began from. k8s-service works out from it what the edit took out of the object
// (editedPatch). The two texts whole would pass the body limit at half the size of the largest object.
export function yamlOpenedOf(opened: string, saved: string): YamlOpened {
  const from = opened.split('\n')
  const to = saved.split('\n')
  let head = 0
  while (head < from.length && head < to.length && from[head] === to[head]) head++
  let tail = 0
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++
  return { head, tail, lines: from.slice(head, from.length - tail) }
}

export function kindToPlural(kind: string): string {
  const map: Record<string, string> = {
    Pod: 'pod', Node: 'node', Namespace: 'namespace', Service: 'service',
    Deployment: 'deployment', ReplicaSet: 'replicaset', StatefulSet: 'statefulset',
    DaemonSet: 'daemonset', Job: 'job', CronJob: 'cronjob',
    ConfigMap: 'configmap', Secret: 'secret', Ingress: 'ingress',
    NetworkPolicy: 'networkpolicy', PersistentVolumeClaim: 'persistentvolumeclaim',
    PersistentVolume: 'persistentvolume', HorizontalPodAutoscaler: 'horizontalpodautoscaler',
    VerticalPodAutoscaler: 'verticalpodautoscaler',
    ValidatingAdmissionPolicy: 'validatingadmissionpolicy', MutatingAdmissionPolicy: 'mutatingadmissionpolicy',
    Endpoints: 'endpoints', EndpointSlice: 'endpointslice',
    IngressClass: 'ingressclass',
    Gateway: 'gateway',
    GatewayClass: 'gatewayclass',
    HTTPRoute: 'httproute',
    GRPCRoute: 'grpcroute',
    ReferenceGrant: 'referencegrant',
    BackendTLSPolicy: 'backendtlspolicy',
    DeviceClass: 'deviceclass',
    ResourceClaim: 'resourceclaim',
    ResourceClaimTemplate: 'resourceclaimtemplate',
    ResourceSlice: 'resourceslice',
    StorageClass: 'storageclass',
    VolumeAttachment: 'volumeattachment',
    ServiceAccount: 'serviceaccount',
    Role: 'role',
    RoleBinding: 'rolebinding',
    ClusterRole: 'clusterrole',
    ClusterRoleBinding: 'clusterrolebinding',
    PodDisruptionBudget: 'poddisruptionbudget',
    PriorityClass: 'priorityclass',
    RuntimeClass: 'runtimeclass',
    Lease: 'lease',
    ResourceQuota: 'resourcequota',
    LimitRange: 'limitrange',
    MutatingWebhookConfiguration: 'mutatingwebhookconfiguration',
    ValidatingWebhookConfiguration: 'validatingwebhookconfiguration',
    CustomResourceDefinition: 'customresourcedefinition',
    CustomResourceInstance: 'customresourceinstance',
  }
  return map[kind] ?? kind.toLowerCase()
}

