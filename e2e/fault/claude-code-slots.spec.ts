import { test, expect, type APIRequestContext } from '@playwright/test'

import { CLUSTER, STAMP, bearer, envOf, forwardTo, killNoSignal, login, psql, readyPods, rolledOut, sleep, undoPending, type Forward } from './shared'

// PR #859 (Claude Code slots in the database): every ai-service replica takes a chat run's place in
// claude_code_slots, so the install runs at most maxConcurrentTotal Claude Code processes however many servers there
// are; a run that finds every slot taken waits up to queueWaitSeconds with `{"queued": true}` in its stream, then ends
// as busy (`error_key` claudeCodeBusy); a holder refreshes its heartbeat every 15 s and a slot whose heartbeat is 60 s
// old is taken by the next run. Step 3 §7 M-4: "the cap holds on two servers; a server killed → its slot free within
// 60 s".
//
// The other runs the cap is counted against are rows this test writes as holders (owner `e2e-w6-<run>-<n>`, a fresh
// heartbeat every 10 s), so one real chat turn per server is enough and the test does not depend on how long the model
// takes to answer. Every row it wrote is set free after. Needs two ready ai-service pods, the default model on provider
// claude-code (scripts/kind-model-subscription.sh up) and migration 00025's table; skips with the reason otherwise.
// Each real turn spends one short answer of the subscription.

const AI = 'ai-service'
const LANE = 'chat'
const FAKE = `e2e-w6-${STAMP}`
// rows of the run's holders whose heartbeat the test keeps fresh
const fresh = new Set<number>()
let beating: NodeJS.Timeout | null = null

type Event = { at: number; data: Record<string, unknown> }
type Turn = { events: Event[]; ended: Promise<void>; startedAt: number }
// rows of claude_code_slots at one moment: how many each of the two servers holds
type Sample = { at: number; byA: number; byB: number }

const total = () => {
  const t = Number(envOf(AI, 'AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL') || '0')
  return t > 0 ? t : Number(envOf(AI, 'AI_CLAUDE_CODE_MAX_CONCURRENT') || '2')
}
const queueWait = () => Number(envOf(AI, 'AI_CLAUDE_CODE_QUEUE_WAIT') || '60')

function hold(slots: number[], ageSeconds = 0) {
  if (!slots.length) return
  psql(`INSERT INTO claude_code_slots (lane, slot, owner, heartbeat_at) VALUES ${slots.map((n) => `('${LANE}', ${n}, '${FAKE}-${n}', NOW() - make_interval(secs => ${ageSeconds}))`).join(', ')}
        ON CONFLICT (lane, slot) DO UPDATE SET owner = EXCLUDED.owner, heartbeat_at = EXCLUDED.heartbeat_at`)
}

function keepFresh(slots: number[]) {
  slots.forEach((n) => fresh.add(n))
  if (beating) return
  beating = setInterval(() => {
    if (fresh.size) psql(`UPDATE claude_code_slots SET heartbeat_at = NOW() WHERE lane = '${LANE}' AND owner IN (${[...fresh].map((n) => `'${FAKE}-${n}'`).join(', ')})`)
  }, 10_000)
}

function letGo(slots?: number[]) {
  for (const n of slots ?? [...fresh]) fresh.delete(n)
  const which = slots ? `owner IN (${slots.map((n) => `'${FAKE}-${n}'`).join(', ')})` : `owner LIKE '${FAKE}-%'`
  psql(`UPDATE claude_code_slots SET owner = '', heartbeat_at = NULL WHERE lane = '${LANE}' AND ${which}`)
}

type SlotRow = { slot: number; owner: string; age: number | null; now: number }
function slots(): SlotRow[] {
  const out = psql(`SELECT slot, owner, EXTRACT(EPOCH FROM (NOW() - heartbeat_at)), EXTRACT(EPOCH FROM NOW()) FROM claude_code_slots WHERE lane = '${LANE}' ORDER BY slot`)
  return out.split('\n').filter(Boolean).map((l) => {
    const [slot, owner, age, now] = l.split('|')
    return { slot: Number(slot), owner, age: age === '' ? null : Number(age), now: Number(now) }
  })
}

// A chat turn sent to one ai-service pod, read as it streams.
function turn(f: Forward, token: string, session: string, message: string): Turn {
  const events: Event[] = []
  const startedAt = Date.now()
  const ended = (async () => {
    const res = await fetch(`http://127.0.0.1:${f.port}/api/v1/ai/sessions/${session}/chat`, {
      method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json', 'X-Cluster-Name': CLUSTER },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok || !res.body) { events.push({ at: Date.now(), data: { http: res.status } }); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') { events.push({ at: Date.now(), data: { done: true } }); continue }
        try { events.push({ at: Date.now(), data: JSON.parse(raw) }) } catch { /* a partial line of text */ }
      }
    }
  })().catch((e: Error) => { events.push({ at: Date.now(), data: { broken: e.message } }) })
  return { events, ended, startedAt }
}

const queuedAt = (t: Turn, v: boolean) => t.events.find((e) => e.data.queued === v)?.at ?? null
const busy = (t: Turn) => t.events.find((e) => e.data.error_key === 'claudeCodeBusy') ?? null
// The run's process is alive at `at` when the turn had started a second before and still gets answer text a second
// after: text comes only from the running Claude Code process, which holds its slot until it ends (#859 claude_code.py).
const runningAt = (t: Turn, at: number) => {
  const start = queuedAt(t, false)
  return start !== null && start <= at - 1_000 && t.events.some((e) => typeof e.data.content === 'string' && e.at >= at + 1_000)
}

async function newSession(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.post(`/api/v1/sessions?cluster=${CLUSTER}`, { headers: bearer(token), data: { title: `e2e-w6-slots-${STAMP}` } })
  expect(res.ok(), `session: ${res.status()}`).toBeTruthy()
  return (await res.json()).id as string
}

test.describe('Claude Code slots across replicas (PR #859, M-4)', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const sessions: string[] = []
  const forwards: Forward[] = []

  test.beforeAll(async ({ request }) => {
    test.skip(readyPods(AI).length < 2, 'needs two ready ai-service pods (replicas.aiService: 2)')
    token = await login(request)
    const models = await (await request.get('/api/v1/ai/model-configs', { headers: bearer(token) })).json()
    const def = (Array.isArray(models) ? models : models.items ?? []).find((m: { is_default?: boolean }) => m.is_default)
    test.skip(def?.provider !== 'claude-code', 'the default model is not on provider claude-code (scripts/kind-model-subscription.sh up)')
    test.skip(psql("SELECT to_regclass('claude_code_slots') IS NOT NULL") !== 't', 'no claude_code_slots table (migration 00025 of PR #859)')
  })

  test.afterEach(() => {
    undoPending()
    if (beating) { clearInterval(beating); beating = null }
    try { letGo() } catch { /* no table: the group skipped before writing a row */ }
    forwards.splice(0).forEach((f) => f.close())
  })

  test.afterAll(async ({ request }) => {
    for (const s of sessions) await request.delete(`/api/v1/sessions/${s}`, { headers: bearer(token), failOnStatusCode: false })
  })

  test('the install-wide cap holds on two servers: both wait while every slot is held, one freed slot starts exactly one, the other goes on only when a slot is free', async ({ request }) => {
    const n = total()
    const wait = queueWait()
    test.setTimeout((wait + 180) * 1000)
    const all = Array.from({ length: n }, (_, i) => i)
    hold(all)
    keepFresh(all)
    const [a, b] = readyPods(AI).map((p) => p.name)
    const fa = await forwardTo(a, 8001); forwards.push(fa)
    const fb = await forwardTo(b, 8001); forwards.push(fb)
    const sa = await newSession(request, token); sessions.push(sa)
    const sb = await newSession(request, token); sessions.push(sb)

    const ta = turn(fa, token, sa, 'Answer with the single word: ok')
    const tb = turn(fb, token, sb, 'Answer with the single word: ok')
    await expect.poll(() => [queuedAt(ta, true) !== null, queuedAt(tb, true) !== null], { message: 'both turns say they wait', timeout: 15_000 }).toEqual([true, true])
    const samples: Sample[] = []
    // stamped before the read: a sample at or after a turn's start was read after it
    const sample = () => {
      const at = Date.now()
      const rows = slots()
      const s = { at, byA: rows.filter((r) => r.owner.startsWith(`${a}-`)).length, byB: rows.filter((r) => r.owner.startsWith(`${b}-`)).length }
      samples.push(s)
      return s
    }
    const first = sample()
    expect(first.byA + first.byB, 'no server took a slot while all were held').toBe(0)

    // one slot comes free: one of the two takes it within a poll, the other keeps waiting
    letGo([0])
    await expect.poll(() => { const s = sample(); return s.byA + s.byB }, { message: 'one turn takes the freed slot', timeout: 5_000, intervals: [250] }).toBe(1)
    const taker = samples[samples.length - 1].byA ? ta : tb
    const waiter = taker === ta ? tb : ta
    expect(queuedAt(taker, false), 'the turn that took the slot says it started').not.toBeNull()

    // both runs to their end, the rows read about every 250 ms
    let ended = 0
    void Promise.all([ta.ended, tb.ended]).then(() => { ended = Date.now() })
    const until = Date.now() + (wait + 90) * 1000
    while (Date.now() < until && !ended) {
      sample()
      await sleep(250)
    }
    await Promise.all([ta.ended, tb.ended])
    test.info().attach('slot-samples.json', { body: JSON.stringify({ samples, taker: taker === ta ? a : b, starts: { [a]: queuedAt(ta, false), [b]: queuedAt(tb, false) } }), contentType: 'application/json' })

    // one slot was given back, so the two servers never hold more than one row between them
    expect(samples.filter((s) => s.byA + s.byB > 1).map((s) => `${new Date(s.at).toISOString()} ${a}:${s.byA} ${b}:${s.byB}`), 'moments the two servers held more than the one slot given back').toEqual([])
    // a run whose process was alive held a row of its server (a run without one would be past the cap)
    const unheld = samples.filter((s) => (runningAt(ta, s.at) && s.byA < 1) || (runningAt(tb, s.at) && s.byB < 1))
    expect(unheld.map((s) => `${new Date(s.at).toISOString()} ${a}:${s.byA} ${b}:${s.byB}`), 'moments a running turn\'s server held no row').toEqual([])
    // each turn that started had its server's row at its start (the first read within 1.5 s after it)
    for (const [t, by, name] of [[ta, 'byA', a], [tb, 'byB', b]] as const) {
      const start = queuedAt(t, false)
      if (start === null) continue
      const next = samples.find((s) => s.at >= start && s.at <= start + 1_500)
      expect(next ? next[by] : null, `${name}'s row read within 1.5 s of its turn starting`).toBe(1)
    }
    expect(busy(taker), 'the turn that took the freed slot is not busy').toBeNull()
    expect(queuedAt(waiter, false) !== null || busy(waiter) !== null, 'the other turn either started on the slot set free or ended busy').toBe(true)
  })

  test('every slot held for the whole queue wait: a turn waits, takes none, and ends busy after queueWaitSeconds', async ({ request }) => {
    const n = total()
    const wait = queueWait()
    test.setTimeout((wait + 120) * 1000)
    const all = Array.from({ length: n }, (_, i) => i)
    hold(all)
    keepFresh(all)
    const [a] = readyPods(AI).map((p) => p.name)
    const fa = await forwardTo(a, 8001); forwards.push(fa)
    const sa = await newSession(request, token); sessions.push(sa)
    const t = turn(fa, token, sa, 'Answer with the single word: ok')
    await expect.poll(() => queuedAt(t, true) !== null, { message: 'the turn says it waits', timeout: 15_000 }).toBe(true)
    let took = false
    while (!busy(t) && Date.now() - t.startedAt < (wait + 20) * 1000) {
      took ||= slots().some((r) => r.owner.startsWith(`${a}-`))
      await sleep(500)
    }
    await t.ended
    expect(took, 'the server took no slot while all were held').toBe(false)
    const ended = busy(t)
    expect(ended?.data.error_key, 'the turn ends as busy').toBe('claudeCodeBusy')
    const waited = (ended!.at - t.startedAt) / 1000
    expect(waited, `seconds the turn waited (queueWaitSeconds ${wait})`).toBeGreaterThanOrEqual(wait - 1)
    expect(waited).toBeLessThanOrEqual(wait + 10)
  })

  test('a slot whose holder stopped beating is taken by a waiting run on another server at 60 s, not before', async ({ request }) => {
    const n = total()
    test.setTimeout(240_000)
    // slot 0: a holder that died 40 s ago (its heartbeat is not refreshed), so the turn below is waiting before it goes
    // stale; the rest held fresh
    const rest = Array.from({ length: n - 1 }, (_, i) => i + 1)
    hold(rest)
    keepFresh(rest)
    hold([0], 40)
    const [, b] = readyPods(AI).map((p) => p.name)
    const fb = await forwardTo(b, 8001); forwards.push(fb)
    const sb = await newSession(request, token); sessions.push(sb)
    const t = turn(fb, token, sb, 'Answer with the single word: ok')
    await expect.poll(() => queuedAt(t, true) !== null, { message: 'the turn waits', timeout: 15_000 }).toBe(true)

    let takenAtAge: number | null = null
    let lastAge = 0
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const row = slots().find((r) => r.slot === 0)!
      if (row.owner.startsWith(`${b}-`)) { takenAtAge = lastAge; break }
      expect(row.owner, 'nobody else took the stale slot').toBe(`${FAKE}-0`)
      lastAge = row.age ?? lastAge
      await sleep(250)
    }
    test.info().annotations.push({ type: 'taken at heartbeat age', description: `${takenAtAge} s` })
    expect(takenAtAge, 'the waiting run took the slot').not.toBeNull()
    expect(takenAtAge!, 'not before the heartbeat is 60 s old (age at the last read before the take)').toBeGreaterThanOrEqual(59)
    expect(takenAtAge!, 'within a poll and a read of 60 s').toBeLessThanOrEqual(62)
    await t.ended
  })

  test('a server killed with no SIGTERM while its run holds a slot: the other server takes it 59–62 s after its last heartbeat, not before', async ({ request }) => {
    const n = total()
    test.setTimeout(300_000)
    const rest = Array.from({ length: n - 1 }, (_, i) => i + 1)
    hold(rest)
    keepFresh(rest)
    letGo([0])
    const [a, b] = readyPods(AI).map((p) => p.name)
    const fa = await forwardTo(a, 8001); forwards.push(fa)
    const fb = await forwardTo(b, 8001); forwards.push(fb)
    const sa = await newSession(request, token); sessions.push(sa)
    const sb = await newSession(request, token); sessions.push(sb)
    try {
      // a turn on server A takes slot 0; A is killed as soon as the row says so
      const ta = turn(fa, token, sa, 'Count from 1 to 200, one number per line.')
      await expect.poll(() => slots().find((r) => r.slot === 0)?.owner.startsWith(`${a}-`) ?? false, { message: `${a} takes slot 0`, timeout: 30_000, intervals: [200] }).toBe(true)
      const deadBeat = slots().find((r) => r.slot === 0)!
      const beatEpoch = deadBeat.now - (deadBeat.age ?? 0)
      // SIGKILL with no SIGTERM, so the server cannot set its slot free on the way out: the slot frees only as stale
      killNoSignal(a)
      void ta.ended

      // a turn on B, started once the dead slot is at most 45 s from stale so its queue wait covers the rest
      while ((slots().find((r) => r.slot === 0)?.age ?? 60) < 15 && slots().find((r) => r.slot === 0)?.owner.startsWith(`${a}-`)) await sleep(1_000)
      const tb = turn(fb, token, sb, 'Answer with the single word: ok')
      let takenAfter: number | null = null
      let releasedOnShutdown = false
      const deadline = Date.now() + 80_000
      while (Date.now() < deadline) {
        const row = slots().find((r) => r.slot === 0)!
        if (row.owner === '') releasedOnShutdown = true
        if (row.owner.startsWith(`${b}-`)) { takenAfter = row.now - beatEpoch; break }
        await sleep(250)
      }
      test.info().annotations.push({ type: 'slot 0', description: `taken by ${b} ${takenAfter} s after ${a}'s last heartbeat${releasedOnShutdown ? ' (set free before that)' : ''}` })
      expect(releasedOnShutdown, `slot 0 was set free before ${b} took it (a SIGKILLed server cannot)`).toBe(false)
      expect(takenAfter, `${b}'s turn took the slot ${a} held`).not.toBeNull()
      expect(takenAfter!, 'not before the dead holder\'s heartbeat is 60 s old (s after it)').toBeGreaterThanOrEqual(59)
      expect(takenAfter!, 'seconds from the dead holder\'s last heartbeat to the take').toBeLessThanOrEqual(62)
      expect(busy(tb), 'the turn on the server left is not busy').toBeNull()
      await tb.ended
    } finally {
      rolledOut(AI)
    }
  })
})
