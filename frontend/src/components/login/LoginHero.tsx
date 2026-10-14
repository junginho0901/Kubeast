// The sign-in page's left side: the Kubeast icon as particles that make room for the pointer, and the
// feature names scattered around it.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_PHYSICS,
  dotColor,
  introAt,
  makeDust,
  makeIntro,
  parallax,
  sampleImage,
  scatterWords,
  seeded,
  stepDot,
  type Dot,
  type Intro,
  type PlacedWord,
} from '@/utils/particles'
import { LOGIN_AMBIENT, LOGIN_WORDS } from './features'

// How far the nearest and farthest layers move with the pointer, CSS px.
const PARALLAX = 16

// On load everything comes in from the edges: the dots first, the names a little after. ms.
const DOT_TIMING = { delay: [0, 400] as [number, number], dur: [1000, 1400] as [number, number] }
const WORD_TIMING = { delay: [250, 700] as [number, number], dur: [1100, 1450] as [number, number] }

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type Area = { x: number; y: number; w: number; h: number }

// Draw /icon.svg on a hidden canvas and turn its pixels into dots, each with its way in (from anywhere in
// the area) if there is one.
function loadDots(size: number, cx: number, cy: number, area: Area | null): Promise<Dot[]> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const off = document.createElement('canvas')
      off.width = off.height = size
      const ctx = off.getContext('2d', { willReadFrequently: true })
      if (!ctx) return resolve([])
      ctx.drawImage(img, 0, 0, size, size)
      // A coarser grid with each point moved at random: no raster, fewer and softer dots.
      const step = Math.max(4, Math.round(size / 74))
      const rand = seeded(42)
      const introRand = seeded(5)
      const samples = sampleImage(ctx.getImageData(0, 0, size, size).data, size, size, step, rand, 0.3)
      const dots = samples.map((s): Dot => {
        const hx = cx - size / 2 + s.x
        const hy = cy - size / 2 + s.y
        const big = rand() < 0.08
        const intro = area ? makeIntro(hx, hy, area, introRand, DOT_TIMING) : undefined
        return {
          hx,
          hy,
          x: intro ? intro.sx : hx,
          y: intro ? intro.sy : hy,
          intro,
          vx: 0,
          vy: 0,
          radius: (big ? 1.9 + rand() * 0.9 : 0.8 + rand() * 0.9) * (s.edge ? 1.15 : 1) * (step / 4.5),
          color: dotColor(s, size, rand),
          // the face bright, the outline brighter still, the body's inside a little dimmer: the icon reads
          alpha: s.edge ? 1 : s.white ? 0.95 : 0.62 + rand() * 0.3,
          phase: rand() * Math.PI * 2,
        }
      })
      resolve(dots)
    }
    img.onerror = () => resolve([])
    img.src = '/icon.svg'
  })
}

export function LoginHero() {
  const { t } = useTranslation()
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  // near: the features, in front of the logo; far: the Kubernetes names behind it
  const [layers, setLayers] = useState<{ near: PlacedWord[]; far: PlacedWord[] }>({ near: [], far: [] })
  const wordEls = useRef(new Map<string, HTMLElement>())
  const glowRef = useRef<HTMLDivElement>(null)
  // The way in plays once per page: the names and the glow stay hidden until it starts.
  const [entering, setEntering] = useState(() => !reducedMotion())
  const played = useRef(false)

  // Size from the column; the logo and the words are laid out for it.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      const h = Math.round(e.contentRect.height)
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!box || box.w === 0) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    // The canvas covers the whole window, so the dots can come in from anywhere in it. Everything is laid
    // out in the box's coordinates and drawn shifted by where the box sits in the window.
    const shift = { x: 0, y: 0 }
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect()
      if (r) {
        shift.x = r.left
        shift.y = r.top
      }
    }
    place()
    const area: Area = { x: -shift.x, y: -shift.y, w: window.innerWidth, h: window.innerHeight }

    const size = Math.round(Math.min(box.w, box.h) * 0.72)
    const cx = box.w / 2
    const cy = box.h / 2
    const logo = { cx, cy, r: size * 0.52 }
    const near = scatterWords(LOGIN_WORDS, box, logo, { seed: 7, depth: [0.55, 1], fontSize: [10.5, 16.5], opacity: [0.45, 0.95], avoidLogo: true })
    const far = scatterWords(LOGIN_AMBIENT, box, logo, { seed: 13, depth: [0, 0.4], fontSize: [9.5, 12.5], opacity: [0.22, 0.5], avoidLogo: false, avoid: near })
    setLayers({ near, far })
    const placed = [...near, ...far]
    const dust = makeDust(Math.round((box.w * box.h) / 2600), box)

    const still = reducedMotion()
    const enter = !still && !played.current
    // each name's way in, from where its centre starts to where it sits
    const wordIntros = new Map<string, Intro>()
    if (enter) {
      const rand = seeded(21)
      for (const w of placed) wordIntros.set(w.id, makeIntro(w.x + w.width / 2, w.y + w.height / 2, area, rand, WORD_TIMING))
    } else {
      // laid out again after the way in (a resize): show everything where it is
      for (const el of wordEls.current.values()) {
        el.style.opacity = ''
        el.style.filter = ''
      }
      if (glowRef.current) glowRef.current.style.opacity = ''
      setEntering(false)
    }
    let start = -1
    let arrived = false
    let dots: Dot[] = []
    let fades = new Float32Array(0)
    let frame = 0
    let cancelled = false
    // the pointer as -1..1 from the centre, eased so the layers glide
    const eased = { x: 0, y: 0 }
    // each word's current offset, eased toward where its float and parallax put it
    const offsets = new Map<string, { x: number; y: number }>()

    // One soft glow per colour (bright core, fading edge), drawn scaled for every dot.
    const sprites = new Map<string, HTMLCanvasElement>()
    const sprite = (color: string) => {
      let s = sprites.get(color)
      if (!s) {
        s = document.createElement('canvas')
        s.width = s.height = 32
        const g = s.getContext('2d')
        if (g) {
          const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
          grad.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ',1)'))
          grad.addColorStop(0.45, color.replace('rgb', 'rgba').replace(')', ',0.7)'))
          grad.addColorStop(1, color.replace('rgb', 'rgba').replace(')', ',0)'))
          g.fillStyle = grad
          g.fillRect(0, 0, 32, 32)
        }
        sprites.set(color, s)
      }
      return s
    }

    const draw = (time: number) => {
      if (start < 0) start = time
      const elapsed = time - start
      // the glow and the specks fade in with the way in
      const dawn = enter ? Math.min(1, elapsed / 1400) : 1
      if (enter && glowRef.current) glowRef.current.style.opacity = dawn < 1 ? String(dawn) : ''
      let moving = 0
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(dpr, 0, 0, dpr, shift.x * dpr, shift.y * dpr)
      const target = pointer.current ? { x: (pointer.current.x - cx) / cx, y: (pointer.current.y - cy) / cy } : { x: 0, y: 0 }
      eased.x += (target.x - eased.x) * 0.06
      eased.y += (target.y - eased.y) * 0.06

      // Specks at their depths, shifting with the pointer.
      for (const s of dust) {
        const { dx, dy } = parallax(s.z, eased.x, eased.y, PARALLAX)
        ctx.globalAlpha = dawn * s.alpha * (still ? 1 : 0.6 + 0.4 * Math.sin(time * 0.0015 + s.phase))
        ctx.fillStyle = '#bae6fd'
        ctx.beginPath()
        ctx.arc(s.x + dx, s.y + dy, s.radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // The words: a slow float of their own plus the parallax of their depth, eased. A name under the
      // pointer holds still, so it can be read and does not slide out from under the pointer.
      if (!still) {
        for (const w of placed) {
          const el = wordEls.current.get(w.id)
          if (!el) continue
          const cur = offsets.get(w.id) ?? { x: 0, y: 0 }
          if (!el.matches(':hover')) {
            const { dx, dy } = parallax(w.z, eased.x, eased.y, PARALLAX)
            const float = 1.5 + w.z * 3
            const tx = dx + Math.sin(time * 0.0004 + w.x * 0.05) * float
            const ty = dy + Math.cos(time * 0.00033 + w.y * 0.05) * float
            cur.x += (tx - cur.x) * 0.2
            cur.y += (ty - cur.y) * 0.2
          }
          offsets.set(w.id, cur)
          // on the way in: off along its path, faded and out of focus until it lands
          let ox = 0
          let oy = 0
          const intro = wordIntros.get(w.id)
          if (intro) {
            const hx = w.x + w.width / 2
            const hy = w.y + w.height / 2
            const at = introAt(intro, hx, hy, elapsed)
            ox = at.x - hx
            oy = at.y - hy
            if (at.p < 1) {
              el.style.opacity = String(Math.min(1, at.p * 1.8))
              el.style.filter = `blur(${((1 - at.e) * 6).toFixed(2)}px)`
            } else {
              wordIntros.delete(w.id)
              el.style.opacity = ''
              el.style.filter = ''
            }
          }
          el.style.transform = `translate3d(${(cur.x + ox).toFixed(2)}px, ${(cur.y + oy).toFixed(2)}px, 0)`
        }
      }

      // A faint halo under every dot (overlapping halos add up, so dense parts shine), then the dot itself
      // as a crisp disc. On the way in a dot follows its path, dim while far out, and the pointer leaves it
      // alone; once home the physics take over.
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]
        if (d.intro) {
          const at = introAt(d.intro, d.hx, d.hy, elapsed)
          d.x = at.x
          d.y = at.y
          fades[i] = 0.35 + 0.65 * at.e
          if (at.p < 1) moving++
          else d.intro = undefined
        } else {
          fades[i] = 1
          if (!still) stepDot(d, pointer.current, time, DEFAULT_PHYSICS)
        }
        const twinkle = still ? 1 : 0.85 + 0.15 * Math.sin(time * 0.002 + d.phase * 3)
        const r = d.radius * 2.6
        ctx.globalAlpha = fades[i] * d.alpha * twinkle * 0.28
        ctx.drawImage(sprite(d.color), d.x - r, d.y - r, r * 2, r * 2)
      }
      ctx.globalCompositeOperation = 'source-over'
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]
        ctx.globalAlpha = fades[i] * (still ? d.alpha : d.alpha * (0.85 + 0.15 * Math.sin(time * 0.002 + d.phase * 3)))
        ctx.fillStyle = d.color
        ctx.beginPath()
        ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      moving += wordIntros.size
      if (enter && !arrived && moving === 0) {
        arrived = true
        setEntering(false)
      }
    }
    const loop = (time: number) => {
      if (cancelled) return
      draw(time)
      frame = requestAnimationFrame(loop)
    }
    // Stop drawing while the tab is hidden.
    const onVisibility = () => {
      cancelAnimationFrame(frame)
      if (!document.hidden && !still && !cancelled) frame = requestAnimationFrame(loop)
    }
    // Follow the window's size and the box's place in it (the still picture is drawn again).
    const onScroll = () => {
      place()
      if (still && dots.length) draw(0)
    }
    const fit = () => {
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      onScroll()
    }
    fit()

    void loadDots(size, cx, cy, enter ? area : null).then((d) => {
      if (cancelled) return
      dots = d
      fades = new Float32Array(d.length).fill(1)
      if (enter) played.current = true
      canvas.dataset.dots = String(d.length)
      if (still) draw(0)
      else frame = requestAnimationFrame(loop)
    })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', onScroll)
    }
  }, [box])

  const onMove = (e: React.PointerEvent) => {
    const r = boxRef.current?.getBoundingClientRect()
    if (r) pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const text = new Map([...LOGIN_WORDS, ...LOGIN_AMBIENT].map((f) => [f.id, f.text]))
  const keep = (id: string) => (el: HTMLElement | null) => {
    if (el) wordEls.current.set(id, el)
    else wordEls.current.delete(id)
  }
  return (
    <div
      ref={boxRef}
      className="relative h-[clamp(420px,58vh,620px)] w-full select-none"
      onPointerMove={onMove}
      onPointerLeave={() => (pointer.current = null)}
      data-testid="login-hero"
      data-state={entering ? 'entering' : 'ready'}
    >
      <div
        ref={glowRef}
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(14,165,233,0.22),rgba(99,102,241,0.10)_32%,rgba(2,6,23,0)_62%)]"
        style={{ opacity: entering ? 0 : undefined }}
      />
      {/* The far layer sits behind the logo: small, dim, a little soft — on hover it comes into focus, less
          than the near layer. */}
      {layers.far.map((w) => (
        <span
          key={w.id}
          ref={keep(w.id)}
          className="absolute whitespace-nowrap will-change-transform"
          style={{ left: w.x, top: w.y, opacity: entering ? 0 : undefined }}
          aria-hidden="true"
        >
          <span
            className="inline-block cursor-default text-sky-100 transition-[scale,opacity,filter] duration-500 ease-in-out [opacity:var(--o)] [filter:var(--blur)] hover:scale-[1.08] hover:[opacity:var(--o-hover)] hover:[filter:blur(0)]"
            style={
              {
                fontSize: w.fontSize,
                lineHeight: 1.3,
                '--o': w.opacity,
                '--o-hover': Math.min(0.8, w.opacity + 0.3),
                '--blur': `blur(${((0.4 - w.z) * 1.5).toFixed(2)}px)`,
              } as React.CSSProperties
            }
            data-testid="login-ambient"
          >
            {text.get(w.id)}
          </span>
        </span>
      ))}
      {/* The whole window, under the sign-in box (z-0 against its z-10). The pointer is read on the box, so
          the canvas lets it through to the words behind and to the page. */}
      <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0 h-full w-full" aria-hidden="true" data-testid="login-particles" />
      {/* The features in front: on hover a little larger and brighter. */}
      {layers.near.map((w) => (
        <span
          key={w.id}
          ref={keep(w.id)}
          className="absolute whitespace-nowrap will-change-transform"
          style={{ left: w.x, top: w.y, opacity: entering ? 0 : undefined }}
          aria-hidden="true"
        >
          <span
            className="inline-block cursor-default font-medium text-slate-100 transition-[scale,opacity,color,text-shadow] duration-500 ease-in-out [opacity:var(--o)] hover:scale-[1.12] hover:text-white hover:[opacity:1] hover:[text-shadow:0_0_14px_rgba(56,189,248,0.75)]"
            style={{ fontSize: w.fontSize, lineHeight: 1.3, '--o': w.opacity } as React.CSSProperties}
            data-testid="login-word"
          >
            {text.get(w.id)}
          </span>
        </span>
      ))}
      <ul className="sr-only" aria-label={t('login.featuresLabel', 'What Kubeast works with')}>
        {LOGIN_WORDS.map((f) => (
          <li key={f.id}>{f.text}</li>
        ))}
      </ul>
    </div>
  )
}
