import { describe, expect, it } from 'vitest'
import { DEFAULT_PHYSICS, easeGather, gradientAt, introAt, makeIntro, parallax, sampleImage, scatterWords, seeded, stepDot, type Dot } from './particles'

const BLUE = [14, 165, 233, 255]
const square = (n: number) => new Uint8ClampedArray(Array.from({ length: n * n }, () => BLUE).flat())

describe('sampleImage', () => {
  it('keeps opaque, not dark pixels on the step grid and marks white ones and edges', () => {
    // 4×1 image: blue opaque, transparent, dark opaque, white opaque
    const data = new Uint8ClampedArray([14, 165, 233, 255, 0, 0, 0, 0, 15, 23, 42, 255, 255, 255, 255, 255])
    expect(sampleImage(data, 4, 1, 1)).toEqual([
      { x: 0, y: 0, white: false, edge: true },
      { x: 3, y: 0, white: true, edge: true },
    ])
    expect(sampleImage(data, 4, 1, 2)).toEqual([{ x: 0, y: 0, white: false, edge: true }])
  })

  it('tells the inside from the outline', () => {
    const points = sampleImage(square(5), 5, 5, 1)
    expect(points.find((p) => p.x === 2 && p.y === 2)?.edge).toBe(false)
    expect(points.find((p) => p.x === 0 && p.y === 0)?.edge).toBe(true)
  })

  it('moves points off the grid but keeps them inside the shape', () => {
    const points = sampleImage(square(40), 40, 40, 4, seeded(1), 0.45)
    expect(points.length).toBeGreaterThan(60)
    expect(points.some((p) => p.x % 4 !== 0 || p.y % 4 !== 0)).toBe(true)
    for (const p of points) {
      expect(Math.round(p.x)).toBeGreaterThanOrEqual(0)
      expect(Math.round(p.x)).toBeLessThan(40)
      expect(Math.round(p.y)).toBeGreaterThanOrEqual(0)
      expect(Math.round(p.y)).toBeLessThan(40)
    }
  })
})

describe('gradientAt', () => {
  it('runs cyan → sky → indigo and clamps', () => {
    expect(gradientAt(-1)).toEqual([6, 182, 212])
    expect(gradientAt(0.5)).toEqual([14, 165, 233])
    expect(gradientAt(2)).toEqual([99, 102, 241])
    expect(gradientAt(0.25)).toEqual([10, 174, 223])
  })
})

const dot = (x: number, y: number): Dot => ({ hx: 100, hy: 100, x, y, vx: 0, vy: 0, radius: 1, color: '', alpha: 1, phase: 0 })
const NO_DRIFT = { ...DEFAULT_PHYSICS, drift: 0 }

describe('stepDot', () => {
  it('pulls a dot home and settles there', () => {
    const d = dot(160, 40)
    for (let i = 0; i < 600; i++) stepDot(d, null, 0, NO_DRIFT)
    expect(Math.hypot(d.x - 100, d.y - 100)).toBeLessThan(1)
  })

  it('pushes a dot away from a pointer within reach, harder when closer, and not beyond it', () => {
    const near = dot(100, 100)
    stepDot(near, { x: 90, y: 100 }, 0, NO_DRIFT)
    const far = dot(100, 100)
    stepDot(far, { x: 30, y: 100 }, 0, NO_DRIFT)
    const out = dot(100, 100)
    stepDot(out, { x: 100, y: 300 }, 0, NO_DRIFT)
    expect(near.x).toBeGreaterThan(far.x)
    expect(far.x).toBeGreaterThan(100)
    expect(Math.abs(out.x - 100)).toBeLessThan(1)
    expect(Math.abs(out.y - 100)).toBeLessThan(1)
  })

  it('flows partly sideways round the pointer', () => {
    const d = dot(100, 100)
    stepDot(d, { x: 90, y: 100 }, 0, NO_DRIFT)
    expect(Math.abs(d.y - 100)).toBeGreaterThan(0.1)
  })

  it('comes back once the pointer leaves', () => {
    const d = dot(100, 100)
    for (let i = 0; i < 30; i++) stepDot(d, { x: 95, y: 100 }, 0, NO_DRIFT)
    expect(Math.hypot(d.x - 100, d.y - 100)).toBeGreaterThan(10)
    for (let i = 0; i < 600; i++) stepDot(d, null, 0, NO_DRIFT)
    expect(Math.hypot(d.x - 100, d.y - 100)).toBeLessThan(1)
  })

  it('wanders a little around home when nothing touches it', () => {
    const d = dot(100, 100)
    d.phase = 1.3
    let farthest = 0
    for (let t = 0; t < 20000; t += 16) {
      stepDot(d, null, t)
      farthest = Math.max(farthest, Math.hypot(d.x - 100, d.y - 100))
    }
    // each axis wanders by up to drift, so a diagonal reaches about drift × √2 (plus the spring's lag)
    expect(farthest).toBeGreaterThan(0.8)
    expect(farthest).toBeLessThan(DEFAULT_PHYSICS.drift * 2)
  })
})

describe('scatterWords', () => {
  const words = Array.from({ length: 16 }, (_, i) => ({ id: `w${i}`, text: `Feature ${i}` }))
  const box = { w: 640, h: 560 }
  const logo = { cx: 320, cy: 280, r: 130 }

  const near = { depth: [0.55, 1] as [number, number], fontSize: [10.5, 16.5] as [number, number], opacity: [0.45, 0.95] as [number, number], avoidLogo: true }

  it('places words in the box, off the logo and apart, with varied size and brightness', () => {
    const placed = scatterWords(words, box, logo, near)
    expect(placed.length).toBeGreaterThanOrEqual(12)
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(4)
      expect(p.y).toBeGreaterThanOrEqual(4)
      expect(p.x + p.width).toBeLessThanOrEqual(box.w - 4)
      expect(p.y + p.height).toBeLessThanOrEqual(box.h - 4)
      const nx = Math.max(p.x, Math.min(logo.cx, p.x + p.width))
      const ny = Math.max(p.y, Math.min(logo.cy, p.y + p.height))
      expect(Math.hypot(nx - logo.cx, ny - logo.cy)).toBeGreaterThanOrEqual(logo.r)
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const [a, b] = [placed[i], placed[j]]
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        expect(apart, `${a.id} / ${b.id}`).toBe(true)
      }
    expect(new Set(placed.map((p) => p.fontSize)).size).toBeGreaterThan(3)
    expect(new Set(placed.map((p) => p.opacity)).size).toBeGreaterThan(3)
  })

  it('lays out the same way every time for one seed', () => {
    expect(scatterWords(words, box, logo, { ...near, seed: 11 })).toEqual(scatterWords(words, box, logo, { ...near, seed: 11 }))
    expect(seeded(3)()).toBe(seeded(3)())
  })

  it('sizes and brightens by depth, lets a far layer sit behind the logo, and keeps the layers apart', () => {
    const front = scatterWords(words, box, logo, near)
    for (const p of front) {
      expect(p.z).toBeGreaterThanOrEqual(0.55)
      expect(p.fontSize).toBeCloseTo(10.5 + (16.5 - 10.5) * p.z, 0)
      expect(p.opacity).toBeCloseTo(0.45 + 0.5 * p.z, 1)
    }
    const back = scatterWords(words, box, logo, { depth: [0, 0.4], fontSize: [9, 11.5], opacity: [0.14, 0.38], avoidLogo: false, avoid: front, seed: 13 })
    expect(back.every((p) => p.z <= 0.4)).toBe(true)
    const behindLogo = back.filter((p) => Math.hypot(p.x + p.width / 2 - logo.cx, p.y + p.height / 2 - logo.cy) < logo.r)
    expect(behindLogo.length).toBeGreaterThan(0)
    for (const a of back)
      for (const b of front) {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        expect(apart, `${a.id} / ${b.id}`).toBe(true)
      }
  })
})

describe('the way in', () => {
  it('sets off slowly, speeds up, lands softly and never passes home', () => {
    expect(easeGather(0)).toBe(0)
    expect(easeGather(1)).toBe(1)
    const speed = (a: number) => (easeGather(a + 0.01) - easeGather(a)) / 0.01
    expect(speed(0.1)).toBeLessThan(0.2)
    expect(speed(0.7)).toBeGreaterThan(2)
    expect(speed(0.98)).toBeLessThan(0.3)
    // one curve, no jump where the two halves meet
    expect(Math.abs(speed(0.74) - speed(0.75))).toBeLessThan(0.1)
    let last = 0
    for (let t = 0; t <= 1; t += 0.01) {
      const e = easeGather(t)
      expect(e).toBeGreaterThanOrEqual(last)
      expect(e).toBeLessThanOrEqual(1)
      last = e
    }
  })

  const box = { w: 640, h: 560 }
  // the window, in the box's coordinates: the box sits at (80, 170) in a 1440 × 900 window
  const area = { x: -80, y: -170, w: 1440, h: 900 }
  const timing = { delay: [100, 300] as [number, number], dur: [1000, 1400] as [number, number] }

  it('starts anywhere in the window or a little past its edges, evenly, the box included', () => {
    const rand = seeded(4)
    const sides = new Set<string>()
    let inBox = 0
    const n = 2000
    for (let i = 0; i < n; i++) {
      const intro = makeIntro(200 + rand() * 240, 180 + rand() * 200, area, rand, timing)
      if (intro.sx >= 0 && intro.sx <= box.w && intro.sy >= 0 && intro.sy <= box.h) inBox++
      expect(intro.sx).toBeGreaterThanOrEqual(area.x - area.w * 0.08)
      expect(intro.sx).toBeLessThanOrEqual(area.x + area.w * 1.08)
      expect(intro.sy).toBeGreaterThanOrEqual(area.y - area.h * 0.08)
      expect(intro.sy).toBeLessThanOrEqual(area.y + area.h * 1.08)
      if (intro.sx < area.x) sides.add('left')
      if (intro.sx > area.x + area.w) sides.add('right')
      if (intro.sy < area.y) sides.add('top')
      if (intro.sy > area.y + area.h) sides.add('bottom')
      expect(intro.delay).toBeGreaterThanOrEqual(100)
      expect(intro.delay).toBeLessThanOrEqual(300)
      expect(intro.dur).toBeGreaterThanOrEqual(1000)
      expect(intro.dur).toBeLessThanOrEqual(1400)
    }
    expect([...sides].sort()).toEqual(['bottom', 'left', 'right', 'top'])
    // the box's share of the grown window, give or take: no empty patch where the box is
    const share = (box.w * box.h) / (area.w * 1.16 * area.h * 1.16)
    expect(inBox / n).toBeGreaterThan(share * 0.7)
    expect(inBox / n).toBeLessThan(share * 1.3)
  })

  it('waits at the start, then follows its path home and stays', () => {
    const intro = makeIntro(300, 260, area, seeded(8), timing)
    expect(introAt(intro, 300, 260, 0)).toMatchObject({ x: intro.sx, y: intro.sy, p: 0 })
    const half = introAt(intro, 300, 260, intro.delay + intro.dur / 2)
    expect(Math.hypot(half.x - 300, half.y - 260)).toBeGreaterThan(Math.hypot(intro.sx - 300, intro.sy - 260) * 0.5)
    expect(introAt(intro, 300, 260, intro.delay + intro.dur)).toMatchObject({ x: 300, y: 260, p: 1 })
    expect(introAt(intro, 300, 260, intro.delay + intro.dur + 5000)).toMatchObject({ x: 300, y: 260, p: 1 })
  })
})

describe('parallax', () => {
  it('moves near layers with the pointer, far ones against it, and leaves the middle', () => {
    expect(parallax(1, 1, 0, 16)).toEqual({ dx: 16, dy: 0 })
    expect(parallax(0, 1, -1, 16)).toEqual({ dx: -16, dy: 16 })
    expect(parallax(0.5, 1, 1, 16)).toEqual({ dx: 0, dy: 0 })
  })
})
