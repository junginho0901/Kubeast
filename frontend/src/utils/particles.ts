// The sign-in page's particle logo: the icon sampled into dots that drift home on a spring and step aside
// from the pointer, and the feature names scattered around it. Pure functions; the canvas lives in
// components/login.

export interface Dot {
  // home (the icon pixel), current position and velocity, in canvas CSS pixels
  hx: number
  hy: number
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  color: string
  // brightness 0..1 (edges brighter) and the phase of its twinkle
  alpha: number
  phase: number
  // the way in on load; gone once the dot is home
  intro?: Intro
}

// A way in: from a start (s) outside the box along a gentle curve (through m) to home, starting delay ms
// after load and taking dur ms.
export interface Intro {
  sx: number
  sy: number
  mx: number
  my: number
  delay: number
  dur: number
}

// Slow, then faster and faster for the first three quarters (cubic), then a short soft landing (quadratic)
// that meets it at the same speed. Never above 1, so nothing passes home and springs back.
export const easeGather = (t: number) => (t <= 0.75 ? (2 / 3) * (t / 0.75) ** 3 : 1 - (1 / 3) * ((1 - t) / 0.25) ** 2)

// Where something on its way in is at elapsed ms: p is the share of its time gone (0..1, 1 is home) and e
// the eased share of the way.
export function introAt(intro: Intro, hx: number, hy: number, elapsed: number): { x: number; y: number; p: number; e: number } {
  const p = Math.min(1, Math.max(0, (elapsed - intro.delay) / intro.dur))
  const e = easeGather(p)
  const u = 1 - e
  return {
    x: u * u * intro.sx + 2 * u * e * intro.mx + e * e * hx,
    y: u * u * intro.sy + 2 * u * e * intro.my + e * e * hy,
    p,
    e,
  }
}

// A start anywhere in the area (the whole window, in the box's coordinates) or a little beyond its edges —
// evenly, so no part of the window starts empty — and a bend for the path in. Every path bends the same way
// round, so the whole lot swirls in together.
export function makeIntro(
  hx: number,
  hy: number,
  area: { x: number; y: number; w: number; h: number },
  rand: () => number,
  timing: { delay: [number, number]; dur: [number, number] },
): Intro {
  const sx = area.x + (-0.08 + rand() * 1.16) * area.w
  const sy = area.y + (-0.08 + rand() * 1.16) * area.h
  const bend = 0.12 + rand() * 0.18
  return {
    sx,
    sy,
    mx: (sx + hx) / 2 - (hy - sy) * bend,
    my: (sy + hy) / 2 + (hx - sx) * bend,
    delay: timing.delay[0] + rand() * (timing.delay[1] - timing.delay[0]),
    dur: timing.dur[0] + rand() * (timing.dur[1] - timing.dur[0]),
  }
}

export interface Sample {
  x: number
  y: number
  white: boolean
  // on the outline of the shape (or of the face): drawn brighter so the form reads
  edge: boolean
}

// Inside the icon: opaque and not dark (the eyes and nose stay out, so the face shows as holes).
function filled(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): boolean {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= width || py >= height) return false
  const i = (py * width + px) * 4
  return data[i + 3] >= 128 && 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] >= 70
}

const isWhite = (data: Uint8ClampedArray, width: number, x: number, y: number) => {
  const i = (Math.round(y) * width + Math.round(x)) * 4
  return Math.min(data[i], data[i + 1], data[i + 2]) > 200
}

// Points inside the icon on a step grid, each moved by up to `jitter` × step at random so no grid shows.
// A point counts as an edge when a neighbour a step away is outside, or of the other colour.
export function sampleImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  step: number,
  rand: () => number = () => 0.5,
  jitter = 0,
): Sample[] {
  const out: Sample[] = []
  for (let gy = 0; gy < height; gy += step) {
    for (let gx = 0; gx < width; gx += step) {
      const x = gx + (rand() - 0.5) * 2 * jitter * step
      const y = gy + (rand() - 0.5) * 2 * jitter * step
      if (!filled(data, width, height, x, y)) continue
      const white = isWhite(data, width, x, y)
      const edge = [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
      ].some(([dx, dy]) => !filled(data, width, height, x + dx, y + dy) || isWhite(data, width, Math.min(width - 1, Math.max(0, x + dx)), Math.min(height - 1, Math.max(0, y + dy))) !== white)
      out.push({ x, y, white, edge })
    }
  }
  return out
}

// Cyan at the top left through sky to indigo at the bottom right (the 500 shades, a little deep).
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [6, 182, 212]],
  [0.5, [14, 165, 233]],
  [1, [99, 102, 241]],
]

export function gradientAt(t: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, t))
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]
    const [t0, c0] = STOPS[i - 1]
    if (v <= t1) {
      const k = (v - t0) / (t1 - t0)
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k)) as [number, number, number]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

// A dot's colour: the face a soft white, the rest the gradient by position across the icon. Colours come in
// a few dozen steps so the canvas can keep one glow sprite per colour.
export function dotColor(s: Sample, size: number, rand: () => number): string {
  if (s.white) {
    const l = [206, 214, 222, 230][Math.floor(rand() * 4)]
    return `rgb(${l},${l},${Math.min(255, l + 4)})`
  }
  const t = Math.round(((s.x + s.y) / (2 * size)) * 24) / 24
  const [r, g, b] = gradientAt(t)
  return `rgb(${r},${g},${b})`
}

export interface PhysicsOptions {
  spring: number // pull toward home per frame
  damping: number // velocity kept per frame
  radius: number // pointer reach, CSS px
  force: number // push at the pointer
  swirl: number // share of the push turned sideways, so dots flow round the pointer
  drift: number // idle wander around home, CSS px
}

// A gentle give rather than a hole: a short reach and a soft push.
export const DEFAULT_PHYSICS: PhysicsOptions = { spring: 0.032, damping: 0.9, radius: 75, force: 1.5, swirl: 0.35, drift: 1.6 }

// One frame: the spring toward home (which wanders slowly by up to drift, each dot at its own pace), and
// away from the pointer within its reach — harder the closer it is, partly sideways.
export function stepDot(d: Dot, pointer: { x: number; y: number } | null, t: number, o: PhysicsOptions = DEFAULT_PHYSICS): void {
  const pace = 0.0006 + (d.phase % 1) * 0.0006
  const tx = d.hx + Math.sin(t * pace + d.phase) * o.drift
  const ty = d.hy + Math.cos(t * pace * 0.8 + d.phase * 1.7) * o.drift
  let ax = (tx - d.x) * o.spring
  let ay = (ty - d.y) * o.spring
  if (pointer) {
    const dx = d.x - pointer.x
    const dy = d.y - pointer.y
    const dist = Math.hypot(dx, dy)
    if (dist < o.radius && dist > 0.001) {
      const push = (1 - dist / o.radius) ** 2 * o.force
      ax += (dx / dist) * push - (dy / dist) * push * o.swirl
      ay += (dy / dist) * push + (dx / dist) * push * o.swirl
    }
  }
  d.vx = (d.vx + ax) * o.damping
  d.vy = (d.vy + ay) * o.damping
  d.x += d.vx
  d.y += d.vy
}

// mulberry32: a small seeded generator, so the layout is the same on every visit.
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PlacedWord {
  id: string
  x: number // left, CSS px in the box
  y: number // top
  // depth 0 (far) .. 1 (near): size, brightness, sharpness and parallax follow it
  z: number
  fontSize: number
  opacity: number
  width: number
  height: number
}

export interface ScatterOptions {
  seed?: number
  depth: [number, number] // z range for these words
  fontSize: [number, number] // at z = 0 and z = 1
  opacity: [number, number] // at z = 0 and z = 1
  // near words keep clear of the logo; far ones may sit behind it
  avoidLogo: boolean
  // words already placed (another layer) to keep clear of
  avoid?: PlacedWord[]
  charWidth?: number
}

const lerp = ([a, b]: [number, number], t: number) => a + (b - a) * t

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

// Scatter the words around a circle (the logo) in a box, each at a random depth in opts.depth — its size and
// brightness follow the depth — none overlapping another word (of this layer or opts.avoid), all inside the
// box, and with opts.avoidLogo clear of the circle (a far layer may sit behind the logo). Each word starts
// from its own share of the circle, so the words go all the way round, and wanders further only when that
// share is full; one that finds no place is left out. Width is estimated from the length (charWidth × size
// per character).
export function scatterWords(
  words: Array<{ id: string; text: string }>,
  box: { w: number; h: number },
  logo: { cx: number; cy: number; r: number },
  opts: ScatterOptions,
): PlacedWord[] {
  const rand = seeded(opts.seed ?? 7)
  const charWidth = opts.charWidth ?? 0.58
  const others = opts.avoid ?? []
  const placed: PlacedWord[] = []
  const share = (Math.PI * 2) / Math.max(1, words.length)
  const start = rand() * Math.PI * 2
  words.forEach((word, i) => {
    const z = Math.round(lerp(opts.depth, rand()) * 100) / 100
    const fontSize = Math.round(lerp(opts.fontSize, z) * 10) / 10
    const opacity = Math.round(lerp(opts.opacity, z) * 100) / 100
    const width = word.text.length * fontSize * charWidth
    const height = fontSize * 1.3
    for (let attempt = 0; attempt < 400; attempt++) {
      const spread = attempt < 120 ? 0.5 : attempt < 240 ? 1.5 : words.length / 2
      const angle = start + (i + (rand() - 0.5) * 2 * spread) * share
      const dist = logo.r * ((opts.avoidLogo ? 1.08 : 0.35) + rand() * 1.7)
      const x = logo.cx + Math.cos(angle) * dist - width / 2
      const y = logo.cy + Math.sin(angle) * dist - height / 2
      const r: Rect = { x, y, w: width, h: height }
      if (x < 4 || y < 4 || x + width > box.w - 4 || y + height > box.h - 4) continue
      if (opts.avoidLogo) {
        // nearest point of the word to the logo's centre must stay outside the circle
        const nx = Math.max(x, Math.min(logo.cx, x + width))
        const ny = Math.max(y, Math.min(logo.cy, y + height))
        if (Math.hypot(nx - logo.cx, ny - logo.cy) < logo.r * 1.04) continue
      }
      if ([...others, ...placed].some((p) => overlaps(r, { x: p.x, y: p.y, w: p.width, h: p.height }, 8))) continue
      placed.push({ id: word.id, x, y, z, fontSize, opacity, width, height })
      break
    }
  })
  return placed
}

export interface Dust {
  x: number
  y: number
  z: number
  radius: number
  alpha: number
  phase: number
}

// Faint specks across the box at random depths: the space the logo and the words float in.
export function makeDust(count: number, box: { w: number; h: number }, seed = 99): Dust[] {
  const rand = seeded(seed)
  return Array.from({ length: count }, () => {
    const z = rand()
    return { x: rand() * box.w, y: rand() * box.h, z, radius: 0.35 + z * 0.9, alpha: 0.12 + z * 0.4, phase: rand() * Math.PI * 2 }
  })
}

// How far a layer at depth z shifts with the pointer: near layers follow it, far ones go the other way, the
// logo (z = 0.5) stays. px, py are the pointer's offset from the centre, -1..1.
export function parallax(z: number, px: number, py: number, strength: number): { dx: number; dy: number } {
  const k = (z - 0.5) * 2 * strength
  return { dx: px * k, dy: py * k }
}
