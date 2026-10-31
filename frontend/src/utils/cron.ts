// When a CronJob schedule fires next, computed as kube-controller-manager does (v1.37): robfig/cron v3.0.1
// ParseStandard on "TZ=<spec.timeZone> <schedule>", then Next. Five fields or a descriptor (@hourly … @every),
// day-of-month OR day-of-week unless either is "*", and Go's clock rules where a zone changes its clock: a time the
// clock skips does not run that day, a time it repeats runs at both. Without a time zone the controller uses the
// kube-controller-manager's zone, which a browser cannot know — the browser's zone stands in and the screen says so.
// The cases in cron.test.ts were written by robfig/cron itself (kubeast/raw/20261101/croner).

type Field = { bits: boolean[]; star: boolean }
type Schedule =
  | { kind: 'spec'; second: Field; minute: Field; hour: Field; dom: Field; month: Field; dow: Field; zone: string }
  | { kind: 'every'; delay: number }
type Bounds = { min: number; max: number; names?: Record<string, number> }
type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number }

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const SECONDS: Bounds = { min: 0, max: 59 }
const MINUTES: Bounds = { min: 0, max: 59 }
const HOURS: Bounds = { min: 0, max: 23 }
const DOM: Bounds = { min: 1, max: 31 }
const MONTHS: Bounds = { min: 1, max: 12, names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } }
const DOW: Bounds = { min: 0, max: 6, names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } }

const mod = (a: number, b: number) => ((a % b) + b) % b

// ---- Go's time in a zone: wall clock of an instant, and time.Date's choice for a wall clock the zone skips or repeats

const formats = new Map<string, Intl.DateTimeFormat>()
function wall(ms: number, zone: string): Wall {
  let f = formats.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(zone, f)
  }
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second }
}

const offset = (ms: number, zone: string) => {
  const w = wall(ms, zone)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (ms - mod(ms, SECOND))
}

// time.Date: the wall clock read as UTC, less the zone's offset there; when that lands in another offset period, that
// period's offset (so a skipped 02:30 becomes 03:30 and a repeated 01:30 is the first one)
function goDate(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const unix = Date.UTC(y, mo - 1, d, h, mi, s)
  return unix - offset(unix - offset(unix, zone), zone)
}

const addDate = (ms: number, months: number, days: number, zone: string) => {
  const w = wall(ms, zone)
  return goDate(w.y, w.mo + months, w.d + days, w.h, w.mi, w.s, zone)
}

function loadLocation(name: string, local: string): string {
  if (name === '' || name === 'UTC') return 'UTC'
  if (name === 'Local') return local
  new Intl.DateTimeFormat('en-US', { timeZone: name }) // throws on a zone it does not know
  return name
}

// ---- robfig/cron v3.0.1 parser.go, standard options (five fields, descriptors)

function atoi(expr: string): number {
  if (!/^[+-]?[0-9]+$/.test(expr)) throw new Error(`failed to parse int from ${expr}`)
  const n = Number(expr)
  if (n < 0) throw new Error(`negative number (${n}) not allowed: ${expr}`)
  return n
}

const intOrName = (expr: string, b: Bounds) => b.names?.[expr.toLowerCase()] ?? atoi(expr)

function getRange(expr: string, b: Bounds, f: Field) {
  const rangeAndStep = expr.split('/')
  const lowAndHigh = rangeAndStep[0].split('-')
  let start: number, end: number, step: number
  let star = false
  if (lowAndHigh[0] === '*' || lowAndHigh[0] === '?') {
    start = b.min
    end = b.max
    star = true
  } else {
    start = intOrName(lowAndHigh[0], b)
    if (lowAndHigh.length === 1) end = start
    else if (lowAndHigh.length === 2) end = intOrName(lowAndHigh[1], b)
    else throw new Error(`too many hyphens: ${expr}`)
  }
  if (rangeAndStep.length === 1) step = 1
  else if (rangeAndStep.length === 2) {
    step = atoi(rangeAndStep[1])
    if (lowAndHigh.length === 1) end = b.max
    if (step > 1) star = false
  } else throw new Error(`too many slashes: ${expr}`)
  if (start < b.min || end > b.max || start > end || step === 0) throw new Error(`bad range: ${expr}`)
  for (let i = start; i <= end; i += step) f.bits[i] = true
  if (star) f.star = true
}

function getField(field: string, b: Bounds): Field {
  const f: Field = { bits: [], star: false }
  for (const expr of field.split(',').filter(Boolean)) getRange(expr, b, f)
  return f
}

const all = (b: Bounds): Field => getField('*', b)
const one = (n: number): Field => ({ bits: Object.assign([], { [n]: true }), star: false })

// time.ParseDuration, in milliseconds
const UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: SECOND, m: MINUTE, h: HOUR }
function parseDuration(text: string): number {
  let rest = text
  const negative = rest[0] === '-'
  if (rest[0] === '-' || rest[0] === '+') rest = rest.slice(1)
  if (rest === '0') return 0
  if (rest === '') throw new Error(`invalid duration ${text}`)
  let total = 0
  while (rest) {
    const m = /^([0-9]*)(?:\.([0-9]*))?([^0-9.]*)/.exec(rest)
    if (!m || (!m[1] && !m[2]) || !(m[3] in UNITS)) throw new Error(`invalid duration ${text}`)
    total += (Number(m[1] || '0') + Number(`0.${m[2] || '0'}`)) * UNITS[m[3]]
    rest = rest.slice(m[0].length)
  }
  return negative ? -total : total
}

function parseDescriptor(spec: string, zone: string): Schedule {
  const at = (minute: Field, hour: Field, dom: Field, month: Field, dow: Field): Schedule =>
    ({ kind: 'spec', second: one(0), minute, hour, dom, month, dow, zone })
  switch (spec) {
    case '@yearly':
    case '@annually': return at(one(0), one(0), one(1), one(1), all(DOW))
    case '@monthly': return at(one(0), one(0), one(1), all(MONTHS), all(DOW))
    case '@weekly': return at(one(0), one(0), all(DOM), all(MONTHS), one(0))
    case '@daily':
    case '@midnight': return at(one(0), one(0), all(DOM), all(MONTHS), all(DOW))
    case '@hourly': return at(one(0), all(HOURS), all(DOM), all(MONTHS), all(DOW))
  }
  if (spec.startsWith('@every ')) {
    const d = parseDuration(spec.slice('@every '.length))
    return { kind: 'every', delay: d < SECOND ? SECOND : d - mod(d, SECOND) }
  }
  throw new Error(`unrecognized descriptor: ${spec}`)
}

function parseStandard(text: string, local: string): Schedule {
  let spec = text
  if (spec.length === 0) throw new Error('empty spec string')
  let zone = local
  if (spec.startsWith('TZ=') || spec.startsWith('CRON_TZ=')) {
    const i = spec.indexOf(' ')
    const eq = spec.indexOf('=')
    if (i < eq + 1) throw new Error(`bad location in ${spec}`) // Go slices spec[eq+1:i] and panics
    zone = loadLocation(spec.slice(eq + 1, i), local)
    spec = spec.slice(i).trim()
  }
  if (spec.startsWith('@')) return parseDescriptor(spec, zone)
  const fields = spec.split(/\s+/).filter(Boolean)
  if (fields.length !== 5) throw new Error(`expected exactly 5 fields, found ${fields.length}: ${spec}`)
  const [minute, hour, dom, month, dow] = fields
  return {
    kind: 'spec', second: getField('0', SECONDS), minute: getField(minute, MINUTES), hour: getField(hour, HOURS),
    dom: getField(dom, DOM), month: getField(month, MONTHS), dow: getField(dow, DOW), zone,
  }
}

// ---- robfig/cron v3.0.1 spec.go SpecSchedule.Next, step for step

function dayMatches(s: Extract<Schedule, { kind: 'spec' }>, w: Wall): boolean {
  const domMatch = !!s.dom.bits[w.d]
  const dowMatch = !!s.dow.bits[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]
  return s.dom.star || s.dow.star ? domMatch && dowMatch : domMatch || dowMatch
}

function specNext(s: Extract<Schedule, { kind: 'spec' }>, from: number): number | null {
  const z = s.zone
  let t = from - mod(from, SECOND) + SECOND
  let added = false
  const yearLimit = wall(t, z).y + 5
  wrap: for (;;) {
    let w = wall(t, z)
    if (w.y > yearLimit) return null
    while (!s.month.bits[w.mo]) {
      if (!added) { added = true; t = goDate(w.y, w.mo, 1, 0, 0, 0, z) }
      t = addDate(t, 1, 0, z)
      w = wall(t, z)
      if (w.mo === 1) continue wrap
    }
    while (!dayMatches(s, w)) {
      if (!added) { added = true; t = goDate(w.y, w.mo, w.d, 0, 0, 0, z) }
      t = addDate(t, 0, 1, z)
      w = wall(t, z)
      if (w.h !== 0) {
        t = w.h > 12 ? t + (24 - w.h) * HOUR : t - w.h * HOUR
        w = wall(t, z)
      }
      if (w.d === 1) continue wrap
    }
    while (!s.hour.bits[w.h]) {
      if (!added) { added = true; t = goDate(w.y, w.mo, w.d, w.h, 0, 0, z) }
      t += HOUR
      w = wall(t, z)
      if (w.h === 0) continue wrap
    }
    while (!s.minute.bits[w.mi]) {
      if (!added) { added = true; t -= mod(t, MINUTE) }
      t += MINUTE
      w = wall(t, z)
      if (w.mi === 0) continue wrap
    }
    while (!s.second.bits[w.s]) {
      if (!added) { added = true; t -= mod(t, SECOND) }
      t += SECOND
      w = wall(t, z)
      if (w.s === 0) continue wrap
    }
    return t
  }
}

/**
 * The next run after `from`. An `@every` schedule counts from `since` (the last schedule time, or the CronJob's
 * creation) as the controller does; without it, from `from`.
 */
export function nextCronRun(
  schedule: string | null | undefined,
  timeZone?: string | null,
  from: Date = new Date(),
  since?: string | Date | null,
): Date | null {
  if (!schedule?.trim()) return null
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    let spec = schedule
    // formatSchedule: a schedule that names its own zone is taken as it is; a zone the controller cannot load stops it
    if (!schedule.includes('TZ') && timeZone) {
      loadLocation(timeZone, local)
      spec = `TZ=${timeZone} ${schedule}`
    }
    const s = parseStandard(spec, local)
    const at = from.getTime()
    if (s.kind === 'spec') {
      const t = specNext(s, at)
      return t === null ? null : new Date(t)
    }
    const start = since ? new Date(since).getTime() : NaN
    if (Number.isNaN(start)) return new Date(at - mod(at, SECOND) + s.delay)
    const first = start - mod(start, SECOND)
    return new Date(first + Math.max(1, Math.floor((at - first) / s.delay) + 1) * s.delay)
  } catch {
    return null
  }
}
