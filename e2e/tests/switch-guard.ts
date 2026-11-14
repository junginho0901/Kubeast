import type { Page, Request, Route } from '@playwright/test'

// The switch guard's tools (switch-guard.spec.ts). A sampler installed before the page's first script records what the
// screen shows on every animation frame (what was painted) and after every DOM change (every state the page held when
// it could paint, so a state shorter than a frame is caught whether or not a paint landed in it); holdAnswers keeps a
// read's answer back until the test lets it go; afterSwitch reads the recording from the moment the screen took the new
// condition and names each thing of the condition before that it still showed.

export type Frame = {
  t: number
  // 'arm', 'paint' (an animation frame), 'dom' (after a DOM change), 'ask' (as the page asked a read)
  src: string
  cluster: string
  ns: string
  tab: string
  probes: Record<string, string>
  rows: string[]
  cards: Record<string, string>
  drawer: string
  yaml: string
  banner: string
}
export type Asked = { t: number; method: string; url: string }
export type Recording = { frames: Frame[]; asked: Asked[]; now: number }
// an element whose text (or attribute, or input value) the sampler records under a name
export type Probe = { sel: string; attr?: string; value?: boolean }
export type ArmOptions = { rows?: string; rowsMax?: number; probes?: Record<string, string | Probe> }

// Runs in the page before its own scripts: nothing from this module is in scope.
function samplerScript() {
  const w = window as unknown as Record<string, unknown>
  if (w.__switchGuard) return
  type P = { sel: string; attr?: string; value?: boolean }
  type Cfg = { rows: string; rowsMax: number; probes: Record<string, P> }
  const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
  const BANNERS = '[data-testid="forbidden-banner"], [data-testid="table-forbidden"], [data-testid="table-load-error"], [data-testid="table-not-installed"]'
  const norm = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
  const text = (el: Element | null) => (el ? norm((el as HTMLElement).innerText ?? el.textContent) : '')
  let cfg: Cfg | null = null
  let frames: Record<string, unknown>[] = []
  let asked: { t: number; method: string; url: string }[] = []
  let last = ''
  const state = (c: Cfg) => {
    const rows: string[] = []
    for (const el of document.querySelectorAll(c.rows)) {
      if (rows.length >= c.rowsMax) break
      // a table row of one cell is its loading or empty line, not a row of the list
      if (el.tagName === 'TR' && el.querySelectorAll(':scope > td').length < 2) continue
      const t = text(el)
      if (t) rows.push(t.slice(0, 300))
    }
    const cards: Record<string, string> = {}
    for (const el of document.querySelectorAll('[data-testid^="stat-value"]')) cards[el.getAttribute('data-testid') ?? ''] = text(el)
    const probes: Record<string, string> = {}
    for (const [name, p] of Object.entries(c.probes)) {
      const el = document.querySelector(p.sel)
      probes[name] = !el ? '' : p.attr ? el.getAttribute(p.attr) ?? '' : p.value ? String((el as HTMLInputElement).value ?? '') : text(el).slice(0, 2000)
    }
    const drawers = document.querySelectorAll(DRAWER)
    const drawer = drawers.length ? drawers[drawers.length - 1] : null
    // the YAML editor's first lines, in the order Monaco places them (its line elements are not in line order)
    const lines = drawer ? [...drawer.querySelectorAll('.monaco-editor .view-lines .view-line')] : []
    const yaml = lines
      .map((l) => [parseFloat((l as HTMLElement).style.top) || 0, norm(l.textContent)] as [number, string])
      .sort((a, b) => a[0] - b[0]).slice(0, 3).map((l) => l[1]).join(' | ')
    return {
      cluster: text(document.querySelector('[data-testid="cluster-picker"]')),
      ns: new URLSearchParams(location.search).get('namespace') ?? '',
      tab: text(document.querySelector('[role="tab"][aria-selected="true"]')),
      probes,
      rows,
      cards,
      drawer: drawer ? text(drawer.firstElementChild).slice(0, 200) : '',
      yaml,
      banner: [...document.querySelectorAll(BANNERS)].map(text).join(' | ').slice(0, 600),
    }
  }
  const sample = (src: string) => {
    if (!cfg || !document.body) return
    let s: ReturnType<typeof state>
    try {
      s = state(cfg)
    } catch {
      return
    }
    const key = JSON.stringify(s)
    if (key === last) return
    last = key
    if (frames.length < 20_000) frames.push({ t: performance.now(), src, ...s })
  }
  const tick = () => {
    sample('paint')
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  // the document itself: an init script runs before <html> exists
  new MutationObserver(() => sample('dom')).observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'aria-selected', 'aria-current', 'aria-pressed', 'data-state', 'disabled'],
  })
  // a read asked: what the screen holds at that moment, then the read, on the frames' clock
  const note = (method: string, url: string) => {
    if (!cfg) return
    sample('ask')
    asked.push({ t: performance.now(), method, url })
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    note(String(method).toUpperCase(), String(url))
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  const fetch0 = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    note(String(init?.method ?? 'GET').toUpperCase(), typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return fetch0.call(window, input, init)
  }
  w.__switchGuard = {
    arm(o: { rows?: string; rowsMax?: number; probes?: Record<string, string | P> }) {
      const probes: Record<string, P> = {}
      for (const [k, v] of Object.entries(o.probes ?? {})) probes[k] = typeof v === 'string' ? { sel: v } : v
      cfg = { rows: o.rows || 'main tbody tr', rowsMax: o.rowsMax || 8, probes }
      frames = []
      asked = []
      last = ''
      sample('arm')
    },
    read() {
      return { frames, asked, now: performance.now() }
    },
    disarm() {
      cfg = null
    },
  }
}

export const installSampler = (page: Page) => page.addInitScript(samplerScript)
type Guard = { arm(o: ArmOptions): void; read(): Recording; disarm(): void }
export const arm = (page: Page, options: ArmOptions = {}) => page.evaluate((o) => (window as unknown as { __switchGuard: Guard }).__switchGuard.arm(o), options)
export const recording = (page: Page) => page.evaluate(() => (window as unknown as { __switchGuard: Guard }).__switchGuard.read())
export const disarm = (page: Page) => page.evaluate(() => (window as unknown as { __switchGuard: Guard }).__switchGuard.disarm())
export const pageNow = (page: Page) => page.evaluate(() => performance.now())

// a JSON answer, or a body of its own type (an SSE stream)
export type Answer = { status?: number; json?: unknown; body?: string; contentType?: string }
export type Hold = {
  ready: Promise<void>
  // how many matching reads were held so far
  held(): number
  // the addresses of the reads held so far
  urls(): URL[]
  // lets every held read go on (to the next route or the server), or answers them all with `answer`; holds no more
  release(answer?: Answer): Promise<void>
}

// Holds every read under /api/v1/ that `match` takes until release(). Registered after a stand-in route, it runs
// first and hands the read to it on release.
export function holdAnswers(page: Page, match: (url: URL, request: Request) => boolean): Hold {
  const waiting: ((answer?: Answer) => Promise<void>)[] = []
  const seen: URL[] = []
  let holding = true
  const handler = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!holding || !match(url, request)) return route.fallback()
    seen.push(url)
    await new Promise<void>((resolve) => {
      waiting.push(async (answer) => {
        try {
          if (answer?.body !== undefined) await route.fulfill({ status: answer.status ?? 200, contentType: answer.contentType, body: answer.body })
          else if (answer) await route.fulfill({ status: answer.status ?? 200, json: answer.json ?? {} })
          else await route.fallback()
        } catch { /* the page went on, or the read was given up */ }
        resolve()
      })
    })
  }
  const ready = page.route('**/api/v1/**', handler).then(() => undefined)
  return {
    ready,
    held: () => seen.length,
    urls: () => [...seen],
    async release(answer?: Answer) {
      holding = false
      await Promise.all(waiting.splice(0).map((go) => go(answer)))
      await page.unroute('**/api/v1/**', handler)
    },
  }
}

export type Watch = {
  // what the case changes, for the messages
  what: string
  // the switch: the first frame showing the new condition (the cluster picker, a namespace or tab probe, a drawer header)
  switched?: (f: Frame) => boolean
  // or the moment the page asked the new condition's read, for a condition with no element of its own (a search)
  askedFor?: (url: URL) => boolean
  // or the moment the sampler was armed (the screen showed nothing of either before)
  fromArm?: boolean
  // row texts of the condition before that the new one does not have
  oldRows?: string[]
  // card values of the condition before ({ 'stat-value-pods': '35' }) that the new one does not show
  oldCards?: Record<string, string>
  // probe values of the condition before that the new one does not show
  oldProbes?: Record<string, string>
  // words of the condition before that no probe, row, notice, drawer header or YAML line may show after the switch
  oldTexts?: string[]
  // no notice (forbidden banner, a list's refused, failed or not-installed line) after the switch
  noNotice?: boolean
  // probes that show nothing after the switch (a Stop button, an answer's waiting dots)
  noProbes?: string[]
  // no row before this moment (the page clock), while the new condition's read is held
  noRowsBefore?: number
}

const show = (f: Frame) => JSON.stringify({ cluster: f.cluster, ns: f.ns, probes: f.probes, rows: f.rows.slice(0, 3), cards: f.cards, drawer: f.drawer, yaml: f.yaml, banner: f.banner })

// What the screen showed of the condition before, from the switch on: the state on screen at the switch and every one
// after it. The first frame of each kind of problem is named, with its time after the switch and what it held.
export function afterSwitch(rec: Recording, w: Watch): string[] {
  const { frames, asked } = rec
  let start = -1
  if (w.fromArm) start = frames.length ? 0 : -1
  else if (w.switched) start = frames.findIndex(w.switched)
  else if (w.askedFor) {
    const a = asked.find((x) => w.askedFor!(new URL(x.url, 'http://page')))
    if (a) start = frames.reduce((at, f, i) => (f.t <= a.t ? i : at), 0)
  }
  if (start < 0) return [`${w.what}: the screen never showed the new condition (${frames.length} frames)`]
  const at = frames[start].t
  const problems: string[] = []
  const named = new Set<string>()
  const say = (kind: string, f: Frame, why: string) => {
    if (named.has(kind) || problems.length >= 8) return
    named.add(kind)
    problems.push(`${w.what}: +${Math.round(f.t - at)} ms (${f.src}) ${why} — ${show(f)}`)
  }
  for (const f of frames.slice(start)) {
    if (w.switched && !w.switched(f)) say('back', f, 'the screen went back to the condition before')
    for (const key of w.oldRows ?? []) if (f.rows.some((r) => r.includes(key))) say(`row ${key}`, f, `a row of the condition before: "${key}"`)
    for (const [id, v] of Object.entries(w.oldCards ?? {})) if (f.cards[id] === v) say(`card ${id}`, f, `${id} shows the condition before's ${v}`)
    for (const [name, v] of Object.entries(w.oldProbes ?? {})) if (v && f.probes[name] === v) say(`probe ${name}`, f, `${name} shows the condition before's "${v}"`)
    for (const word of w.oldTexts ?? []) {
      if ([...Object.values(f.probes), ...f.rows, f.banner, f.drawer, f.yaml].some((s) => s.includes(word))) say(`text ${word}`, f, `the condition before's "${word}"`)
    }
    if (w.noNotice && f.banner) say('notice', f, `a notice the new condition did not give: "${f.banner}"`)
    for (const name of w.noProbes ?? []) if (f.probes[name]) say(`shown ${name}`, f, `${name} is on screen: "${f.probes[name].slice(0, 80)}"`)
    if (w.noRowsBefore !== undefined && f.t < w.noRowsBefore && f.rows.length) say('early rows', f, 'rows before the new condition\'s list answered')
  }
  return problems
}

// The name cell of each of the first rows of the tables in `scope` (the column headed Name, else the first cell with text).
export async function rowNames(page: Page, rows = 'main tbody tr', max = 8): Promise<string[]> {
  return page.evaluate(({ rows, max }) => {
    const out: string[] = []
    for (const tr of document.querySelectorAll(rows)) {
      if (out.length >= max) break
      const cells = [...tr.querySelectorAll(':scope > td')] as HTMLElement[]
      if (cells.length < 2) continue
      const heads = [...(tr.closest('table')?.querySelectorAll('thead th') ?? [])].map((th) => (th as HTMLElement).innerText.trim().toLowerCase())
      let i = heads.findIndex((h) => h === 'name' || h === '이름')
      if (i < 0 || i >= cells.length) i = cells.findIndex((td) => td.innerText.trim())
      const name = (cells[i]?.innerText ?? '').split('\n')[0].trim()
      if (name) out.push(name)
    }
    return out
  }, { rows, max })
}

// Names that can be told apart in a frame: not a dash, a count, an age or a time.
export const tellable = (name: string) => name.length >= 4 && /[a-z]/i.test(name) && !/^\d/.test(name)
