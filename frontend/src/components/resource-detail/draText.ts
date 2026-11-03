// The DRA drawers' tables from the resource.k8s.io/v1 objects as they are written: a claim's requests (exactly or
// firstAvailable), a device's attributes and capacity, a class's config parameters.

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Obj[] : [])
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))

export interface DeviceRequestRow {
  name: string
  deviceClass: string
  selectors: string[]
  count: string
  allocationMode: string
}

// One row per request: its exactly (v1beta1, 1.32–1.33: the request itself), or each firstAvailable subrequest as
// "<request>/<subrequest>" — the name an allocation result gives the subrequest it picked.
export function deviceRequestRows(requests: unknown): DeviceRequestRow[] {
  const row = (name: string, r: Obj): DeviceRequestRow => ({
    name,
    deviceClass: text(r.deviceClassName),
    selectors: arr(r.selectors).map((s) => {
      const expr = obj(s.cel).expression
      return expr ? String(expr) : JSON.stringify(s)
    }),
    count: text(r.count),
    allocationMode: text(r.allocationMode),
  })
  return arr(requests).flatMap((r) => {
    const name = String(r.name ?? '')
    const subs = arr(r.firstAvailable)
    if (subs.length > 0) return subs.map((s) => row(`${name}/${String(s.name ?? '')}`, s))
    return [row(name || '-', r.exactly ? obj(r.exactly) : r)]
  })
}

// A typed value as the API writes it ({int: 0}, {string: "x"}, {version: "1.0.0"}, {bool: true}, capacity {value: "80Gi"}):
// the value alone; anything else as JSON.
export function draValueText(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v as Obj)
    if (keys.length === 1) return String((v as Obj)[keys[0]])
    return JSON.stringify(v)
  }
  return String(v)
}

export function draValueMap(m: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(obj(m)).map(([k, v]) => [k, draValueText(v)]))
}

// A config's opaque parameters: strings and numbers as they are, an object or a list as JSON.
export function configParameterMap(m: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(obj(m)).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)]))
}
