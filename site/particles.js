// The console's sign-in effect (frontend/src/components/login/LoginHero.tsx with utils/particles.ts) for the
// site's first screen: the Kubeast icon as dots that come in from the edges, step aside from the pointer and
// drift home, with Kubernetes names floating round it at different depths.
(function () {
  'use strict'

  // The icon inline: an image from a file: page would taint the canvas and its pixels could not be read.
  var ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M27.50 4.17 Q32.00 2.00 36.50 4.17 L51.73 11.50 Q56.24 13.67 57.35 18.55 L61.11 35.02 Q62.22 39.90 59.11 43.81 L48.57 57.02 Q45.45 60.93 40.45 60.93 L23.55 60.93 Q18.55 60.93 15.43 57.02 L4.89 43.81 Q1.78 39.90 2.89 35.02 L6.65 18.55 Q7.76 13.67 12.27 11.50 Z" fill="#0ea5e9"/><g transform="translate(0 1.5)"><path d="M17 13 L27.5 23.5 L36.5 23.5 L47 13 L50 34 L32 53 L14 34 Z" fill="#fff"/><path d="M20.5 32.5 L28 34.5 L23 37.5 Z" fill="#0f172a"/><path d="M43.5 32.5 L36 34.5 L41 37.5 Z" fill="#0f172a"/><path d="M28 43 L36 43 L32 47.5 Z" fill="#0f172a"/></g></svg>'

  var NEAR = ['Pods', 'Deployments', 'StatefulSets', 'DaemonSets', 'Services', 'Ingress', 'ConfigMaps', 'Secrets', 'Jobs', 'CronJobs', 'Nodes', 'Namespaces']
  var FAR = ['ReplicaSets', 'EndpointSlices', 'PersistentVolumes', 'PersistentVolumeClaims', 'StorageClasses', 'ServiceAccounts', 'Roles',
    'RoleBindings', 'ClusterRoles', 'NetworkPolicies', 'PodDisruptionBudgets', 'ResourceQuotas', 'LimitRanges', 'PriorityClasses',
    'CustomResourceDefinitions', 'HorizontalPodAutoscalers', 'Leases', 'Events', 'IngressClasses', 'GatewayClasses', 'HTTPRoutes',
    'VolumeAttachments', 'RuntimeClasses', 'CSIDrivers']

  var PARALLAX = 16
  var DOT_TIMING = { delay: [0, 400], dur: [1000, 1400] }
  var WORD_TIMING = { delay: [250, 700], dur: [1100, 1450] }
  var PHYSICS = { spring: 0.032, damping: 0.9, radius: 75, force: 1.5, swirl: 0.35, drift: 1.6 }
  var STOPS = [[0, [6, 182, 212]], [0.5, [14, 165, 233]], [1, [99, 102, 241]]]

  function seeded(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  var easeGather = function (t) { return t <= 0.75 ? (2 / 3) * Math.pow(t / 0.75, 3) : 1 - (1 / 3) * Math.pow((1 - t) / 0.25, 2) }

  function introAt(it, hx, hy, elapsed) {
    var p = Math.min(1, Math.max(0, (elapsed - it.delay) / it.dur))
    var e = easeGather(p)
    var u = 1 - e
    return { x: u * u * it.sx + 2 * u * e * it.mx + e * e * hx, y: u * u * it.sy + 2 * u * e * it.my + e * e * hy, p: p, e: e }
  }

  function makeIntro(hx, hy, area, rand, timing) {
    var sx = area.x + (-0.08 + rand() * 1.16) * area.w
    var sy = area.y + (-0.08 + rand() * 1.16) * area.h
    var bend = 0.12 + rand() * 0.18
    return {
      sx: sx, sy: sy,
      mx: (sx + hx) / 2 - (hy - sy) * bend,
      my: (sy + hy) / 2 + (hx - sx) * bend,
      delay: timing.delay[0] + rand() * (timing.delay[1] - timing.delay[0]),
      dur: timing.dur[0] + rand() * (timing.dur[1] - timing.dur[0]),
    }
  }

  function filled(data, w, h, x, y) {
    var px = Math.round(x), py = Math.round(y)
    if (px < 0 || py < 0 || px >= w || py >= h) return false
    var i = (py * w + px) * 4
    return data[i + 3] >= 128 && 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] >= 70
  }
  function isWhite(data, w, x, y) {
    var i = (Math.round(y) * w + Math.round(x)) * 4
    return Math.min(data[i], data[i + 1], data[i + 2]) > 200
  }
  function sampleImage(data, w, h, step, rand, jitter) {
    var out = []
    for (var gy = 0; gy < h; gy += step) {
      for (var gx = 0; gx < w; gx += step) {
        var x = gx + (rand() - 0.5) * 2 * jitter * step
        var y = gy + (rand() - 0.5) * 2 * jitter * step
        if (!filled(data, w, h, x, y)) continue
        var white = isWhite(data, w, x, y)
        var edge = [[step, 0], [-step, 0], [0, step], [0, -step]].some(function (d) {
          return !filled(data, w, h, x + d[0], y + d[1]) ||
            isWhite(data, w, Math.min(w - 1, Math.max(0, x + d[0])), Math.min(h - 1, Math.max(0, y + d[1]))) !== white
        })
        out.push({ x: x, y: y, white: white, edge: edge })
      }
    }
    return out
  }

  function gradientAt(t) {
    var v = Math.min(1, Math.max(0, t))
    for (var i = 1; i < STOPS.length; i++) {
      if (v <= STOPS[i][0]) {
        var k = (v - STOPS[i - 1][0]) / (STOPS[i][0] - STOPS[i - 1][0])
        return [0, 1, 2].map(function (j) { return Math.round(STOPS[i - 1][1][j] + (STOPS[i][1][j] - STOPS[i - 1][1][j]) * k) })
      }
    }
    return STOPS[STOPS.length - 1][1]
  }
  function dotColor(s, size, rand) {
    if (s.white) {
      var l = [206, 214, 222, 230][Math.floor(rand() * 4)]
      return 'rgb(' + l + ',' + l + ',' + Math.min(255, l + 4) + ')'
    }
    var c = gradientAt(Math.round(((s.x + s.y) / (2 * size)) * 24) / 24)
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'
  }

  function stepDot(d, pointer, t) {
    var o = PHYSICS
    var pace = 0.0006 + (d.phase % 1) * 0.0006
    var tx = d.hx + Math.sin(t * pace + d.phase) * o.drift
    var ty = d.hy + Math.cos(t * pace * 0.8 + d.phase * 1.7) * o.drift
    var ax = (tx - d.x) * o.spring
    var ay = (ty - d.y) * o.spring
    if (pointer) {
      var dx = d.x - pointer.x, dy = d.y - pointer.y
      var dist = Math.hypot(dx, dy)
      if (dist < o.radius && dist > 0.001) {
        var push = Math.pow(1 - dist / o.radius, 2) * o.force
        ax += (dx / dist) * push - (dy / dist) * push * o.swirl
        ay += (dy / dist) * push + (dx / dist) * push * o.swirl
      }
    }
    d.vx = (d.vx + ax) * o.damping
    d.vy = (d.vy + ay) * o.damping
    d.x += d.vx
    d.y += d.vy
  }

  function overlaps(a, b, gap) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
  }
  function scatterWords(words, box, logo, opts) {
    var rand = seeded(opts.seed)
    var others = opts.avoid || []
    var placed = []
    var share = (Math.PI * 2) / Math.max(1, words.length)
    var start = rand() * Math.PI * 2
    var lerp = function (r, t) { return r[0] + (r[1] - r[0]) * t }
    words.forEach(function (text, i) {
      var z = Math.round(lerp(opts.depth, rand()) * 100) / 100
      var fontSize = Math.round(lerp(opts.fontSize, z) * 10) / 10
      var opacity = Math.round(lerp(opts.opacity, z) * 100) / 100
      var width = text.length * fontSize * 0.58
      var height = fontSize * 1.3
      for (var attempt = 0; attempt < 400; attempt++) {
        var spread = attempt < 120 ? 0.5 : attempt < 240 ? 1.5 : words.length / 2
        var angle = start + (i + (rand() - 0.5) * 2 * spread) * share
        var dist = logo.r * ((opts.avoidLogo ? 1.08 : 0.35) + rand() * 1.7)
        var x = logo.cx + Math.cos(angle) * dist - width / 2
        var y = logo.cy + Math.sin(angle) * dist - height / 2
        var r = { x: x, y: y, w: width, h: height }
        if (x < 4 || y < 4 || x + width > box.w - 4 || y + height > box.h - 4) continue
        if (opts.avoidLogo) {
          var nx = Math.max(x, Math.min(logo.cx, x + width))
          var ny = Math.max(y, Math.min(logo.cy, y + height))
          if (Math.hypot(nx - logo.cx, ny - logo.cy) < logo.r * 1.04) continue
        }
        if (others.concat(placed).some(function (p) { return overlaps(r, { x: p.x, y: p.y, w: p.width, h: p.height }, 8) })) continue
        placed.push({ text: text, x: x, y: y, z: z, fontSize: fontSize, opacity: opacity, width: width, height: height })
        break
      }
    })
    return placed
  }

  function parallax(z, px, py) {
    var k = (z - 0.5) * 2 * PARALLAX
    return { dx: px * k, dy: py * k }
  }

  function mount(box) {
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    var canvas = document.createElement('canvas')
    canvas.className = 'particles-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    var glow = document.createElement('div')
    glow.className = 'particles-glow'
    box.appendChild(glow)
    var farLayer = document.createElement('div')
    var nearLayer = document.createElement('div')
    farLayer.className = nearLayer.className = 'particles-words'
    box.appendChild(farLayer)
    box.appendChild(canvas)
    box.appendChild(nearLayer)
    var ctx = canvas.getContext('2d')
    var pointer = null
    var frame = 0
    var played = false
    var cleanup = null

    box.addEventListener('pointermove', function (e) {
      var r = box.getBoundingClientRect()
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top }
    })
    box.addEventListener('pointerleave', function () { pointer = null })

    function layout() {
      if (cleanup) cleanup()
      var w = box.clientWidth, h = box.clientHeight
      if (!w || !h) return
      var dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      var size = Math.round(Math.min(w, h) * 0.66)
      var cx = w / 2, cy = h / 2
      var logo = { cx: cx, cy: cy, r: size * 0.52 }
      var near = scatterWords(NEAR, { w: w, h: h }, logo, { seed: 7, depth: [0.55, 1], fontSize: [11, 17], opacity: [0.45, 0.95], avoidLogo: true })
      var far = scatterWords(FAR, { w: w, h: h }, logo, { seed: 13, depth: [0, 0.4], fontSize: [9.5, 12.5], opacity: [0.2, 0.45], avoidLogo: false, avoid: near })
      farLayer.textContent = ''
      nearLayer.textContent = ''
      var area = { x: -w * 0.25, y: -h * 0.25, w: w * 1.5, h: h * 1.5 }
      var enter = !still && !played
      var wordRand = seeded(21)
      var words = near.map(function (p) { return { p: p, layer: nearLayer, near: true } })
        .concat(far.map(function (p) { return { p: p, layer: farLayer, near: false } }))
        .map(function (item) {
          var el = document.createElement('span')
          el.className = item.near ? 'word near' : 'word far'
          el.textContent = item.p.text
          el.style.left = item.p.x + 'px'
          el.style.top = item.p.y + 'px'
          el.style.fontSize = item.p.fontSize + 'px'
          el.style.setProperty('--o', item.p.opacity)
          if (!item.near) el.style.setProperty('--blur', ((0.4 - item.p.z) * 1.5).toFixed(2) + 'px')
          item.layer.appendChild(el)
          var intro = enter ? makeIntro(item.p.x + item.p.width / 2, item.p.y + item.p.height / 2, area, wordRand, WORD_TIMING) : null
          if (intro) el.style.opacity = '0'
          return { el: el, p: item.p, intro: intro, cur: { x: 0, y: 0 } }
        })
      var dustRand = seeded(99)
      var dust = Array.from({ length: Math.round((w * h) / 2600) }, function () {
        var z = dustRand()
        return { x: dustRand() * w, y: dustRand() * h, z: z, r: 0.35 + z * 0.9, a: 0.12 + z * 0.4, phase: dustRand() * Math.PI * 2 }
      })
      var dots = []
      var sprites = {}
      function sprite(color) {
        if (sprites[color]) return sprites[color]
        var s = document.createElement('canvas')
        s.width = s.height = 32
        var g = s.getContext('2d')
        var grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
        grad.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ',1)'))
        grad.addColorStop(0.45, color.replace('rgb', 'rgba').replace(')', ',0.7)'))
        grad.addColorStop(1, color.replace('rgb', 'rgba').replace(')', ',0)'))
        g.fillStyle = grad
        g.fillRect(0, 0, 32, 32)
        sprites[color] = s
        return s
      }
      var start = -1
      var eased = { x: 0, y: 0 }
      var cancelled = false

      function draw(time) {
        if (start < 0) start = time
        var elapsed = time - start
        var dawn = enter ? Math.min(1, elapsed / 1400) : 1
        glow.style.opacity = String(dawn)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        var target = pointer ? { x: (pointer.x - cx) / cx, y: (pointer.y - cy) / cy } : { x: 0, y: 0 }
        eased.x += (target.x - eased.x) * 0.06
        eased.y += (target.y - eased.y) * 0.06
        dust.forEach(function (s) {
          var o = parallax(s.z, eased.x, eased.y)
          ctx.globalAlpha = dawn * s.a * (still ? 1 : 0.6 + 0.4 * Math.sin(time * 0.0015 + s.phase))
          ctx.fillStyle = '#bae6fd'
          ctx.beginPath()
          ctx.arc(s.x + o.dx, s.y + o.dy, s.r, 0, Math.PI * 2)
          ctx.fill()
        })
        if (!still) {
          words.forEach(function (wd) {
            if (!wd.el.matches(':hover')) {
              var o = parallax(wd.p.z, eased.x, eased.y)
              var float = 1.5 + wd.p.z * 3
              wd.cur.x += (o.dx + Math.sin(time * 0.0004 + wd.p.x * 0.05) * float - wd.cur.x) * 0.2
              wd.cur.y += (o.dy + Math.cos(time * 0.00033 + wd.p.y * 0.05) * float - wd.cur.y) * 0.2
            }
            var ox = 0, oy = 0
            if (wd.intro) {
              var hx = wd.p.x + wd.p.width / 2, hy = wd.p.y + wd.p.height / 2
              var at = introAt(wd.intro, hx, hy, elapsed)
              ox = at.x - hx
              oy = at.y - hy
              if (at.p < 1) {
                wd.el.style.opacity = String(Math.min(1, at.p * 1.8))
                wd.el.style.filter = 'blur(' + ((1 - at.e) * 6).toFixed(2) + 'px)'
              } else {
                wd.intro = null
                wd.el.style.opacity = ''
                wd.el.style.filter = ''
              }
            }
            wd.el.style.transform = 'translate3d(' + (wd.cur.x + ox).toFixed(2) + 'px,' + (wd.cur.y + oy).toFixed(2) + 'px,0)'
          })
        }
        ctx.globalCompositeOperation = 'lighter'
        for (var i = 0; i < dots.length; i++) {
          var d = dots[i]
          if (d.intro) {
            var a = introAt(d.intro, d.hx, d.hy, elapsed)
            d.x = a.x
            d.y = a.y
            d.fade = 0.35 + 0.65 * a.e
            if (a.p >= 1) d.intro = null
          } else {
            d.fade = 1
            if (!still) stepDot(d, pointer, time)
          }
          var twinkle = still ? 1 : 0.85 + 0.15 * Math.sin(time * 0.002 + d.phase * 3)
          var rr = d.radius * 2.6
          ctx.globalAlpha = d.fade * d.alpha * twinkle * 0.28
          ctx.drawImage(sprite(d.color), d.x - rr, d.y - rr, rr * 2, rr * 2)
        }
        ctx.globalCompositeOperation = 'source-over'
        for (var j = 0; j < dots.length; j++) {
          var q = dots[j]
          ctx.globalAlpha = q.fade * (still ? q.alpha : q.alpha * (0.85 + 0.15 * Math.sin(time * 0.002 + q.phase * 3)))
          ctx.fillStyle = q.color
          ctx.beginPath()
          ctx.arc(q.x, q.y, q.radius, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
      }
      function loop(time) {
        if (cancelled) return
        draw(time)
        frame = requestAnimationFrame(loop)
      }
      function onVisibility() {
        cancelAnimationFrame(frame)
        if (!document.hidden && !still && !cancelled) frame = requestAnimationFrame(loop)
      }

      var img = new Image()
      img.onload = function () {
        if (cancelled) return
        var off = document.createElement('canvas')
        off.width = off.height = size
        var octx = off.getContext('2d', { willReadFrequently: true })
        octx.drawImage(img, 0, 0, size, size)
        var step = Math.max(4, Math.round(size / 74))
        var rand = seeded(42)
        var introRand = seeded(5)
        dots = sampleImage(octx.getImageData(0, 0, size, size).data, size, size, step, rand, 0.3).map(function (s) {
          var hx = cx - size / 2 + s.x, hy = cy - size / 2 + s.y
          var big = rand() < 0.08
          var intro = enter ? makeIntro(hx, hy, area, introRand, DOT_TIMING) : null
          return {
            hx: hx, hy: hy, x: intro ? intro.sx : hx, y: intro ? intro.sy : hy, intro: intro, vx: 0, vy: 0,
            radius: (big ? 1.9 + rand() * 0.9 : 0.8 + rand() * 0.9) * (s.edge ? 1.15 : 1) * (step / 4.5),
            color: dotColor(s, size, rand),
            alpha: s.edge ? 1 : s.white ? 0.95 : 0.62 + rand() * 0.3,
            phase: rand() * Math.PI * 2, fade: 1,
          }
        })
        if (enter) played = true
        if (still) draw(0)
        else frame = requestAnimationFrame(loop)
      }
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ICON)
      document.addEventListener('visibilitychange', onVisibility)
      cleanup = function () {
        cancelled = true
        cancelAnimationFrame(frame)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    var timer = 0
    var last = { w: 0, h: 0 }
    new ResizeObserver(function () {
      var w = box.clientWidth, h = box.clientHeight
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return
      last = { w: w, h: h }
      clearTimeout(timer)
      timer = setTimeout(layout, last.w ? 120 : 0)
    }).observe(box)
  }

  window.KubeastParticles = { mount: mount }
})()
