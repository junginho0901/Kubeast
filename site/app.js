(function () {
  'use strict'
  var root = document.documentElement
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var titles = {
    en: 'Kubeast — Kubernetes console with an AI that reads your clusters',
    ko: 'Kubeast — 클러스터를 읽는 AI가 함께하는 Kubernetes 콘솔',
  }
  // Each clip's step marks in seconds, written by scripts/site-media.sh from the recording scripts.
  var STEPS = window.KUBEAST_STEPS || {}

  // Language: the docs links follow it (English docs/, Korean docs/ko/).
  function setLang(lang) {
    root.lang = lang
    document.title = titles[lang]
  }
  setLang(root.lang)
  document.getElementById('lang-toggle').addEventListener('click', function () {
    var next = root.lang === 'ko' ? 'en' : 'ko'
    setLang(next)
    try { localStorage.setItem('kubeast-site-lang', next) } catch (e) {}
  })

  var header = document.getElementById('top')
  var onScroll = function () { header.classList.toggle('scrolled', window.scrollY > 8) }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  if (window.KubeastParticles) window.KubeastParticles.mount(document.getElementById('particles'))

  document.querySelectorAll('[data-copy], [data-copy-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.dataset.copy
      if (btn.hasAttribute('data-copy-tab')) {
        var panel = document.querySelector('.tab-panel.active code')
        text = panel.textContent.replace(/^\$ /gm, '').replace(/\s+# .*$/gm, '')
      }
      var done = function () {
        btn.classList.add('copied')
        setTimeout(function () { btn.classList.remove('copied') }, 1400)
      }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {})
    })
  })
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab, .tab-panel').forEach(function (el) { el.classList.remove('active') })
      tab.classList.add('active')
      document.querySelector('.tab-panel[data-panel="' + tab.dataset.tab + '"]').classList.add('active')
    })
  })

  // Steps of a clip at a time: the last mark at or before it (marks from the recording, or spread evenly).
  function marks(clip, items, duration) {
    var known = STEPS[clip]
    return items.map(function (li, i) {
      var at = known && known[li.dataset.step]
      return typeof at === 'number' ? at : (duration || 0) * (i / items.length)
    })
  }
  function stepAt(times, t) {
    var current = 0
    for (var i = 0; i < times.length; i++) if (t + 0.05 >= times[i]) current = i
    return current
  }
  function highlight(list, video, clip) {
    var items = Array.prototype.slice.call(list.querySelectorAll('li'))
    var times = marks(clip, items, video.duration)
    var i = stepAt(times, video.currentTime)
    items.forEach(function (li, j) {
      li.classList.toggle('now', j === i)
      li.classList.toggle('done', j < i)
    })
    return items[i]
  }

  // Cards: hover plays the clip from its start and marks the step it is at. A touch screen has no hover: there a
  // clip plays while its picture is on screen, and a touch that ends a scroll opens nothing.
  var touch = window.matchMedia('(hover: none)').matches
  var scrolledAt = 0
  window.addEventListener('scroll', function () { scrolledAt = Date.now() }, { passive: true })
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'))
  var players = new Map()
  cards.forEach(function (card) {
    var video = card.querySelector('video')
    var steps = card.querySelector('.steps')
    var load = function () { if (!video.src) video.src = video.dataset.src }
    video.addEventListener('timeupdate', function () { highlight(steps, video, card.dataset.clip) })
    video.addEventListener('ended', function () { video.currentTime = 0; video.play().catch(function () {}) })
    var play = function () {
      load()
      video.currentTime = 0
      video.play().catch(function () {})
      card.classList.add('playing')
    }
    var stop = function () {
      video.pause()
      card.classList.remove('playing')
      steps.querySelectorAll('li').forEach(function (li) { li.classList.remove('now', 'done') })
    }
    players.set(card.querySelector('.thumb'), { play: play, stop: stop })
    if (!still && !touch) {
      card.addEventListener('mouseenter', play)
      card.addEventListener('mouseleave', stop)
    }
    card.addEventListener('click', function () {
      if (touch && Date.now() - scrolledAt < 300) return
      open(cards.indexOf(card))
    })
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(cards.indexOf(card)) }
    })
  })
  if (touch && !still && 'IntersectionObserver' in window) {
    var onScreen = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var player = players.get(e.target)
        if (e.isIntersecting) player.play()
        else player.stop()
      })
    }, { threshold: 0.75 })
    players.forEach(function (_, thumb) { onScreen.observe(thumb) })
  }

  // The large view: the clip grows out of its card to the middle of the screen, and back into it on close.
  var lb = document.getElementById('lightbox')
  var frame = lb.querySelector('.lb-video')
  var lbVideo = frame.querySelector('video')
  var caption = lb.querySelector('.lb-caption')
  var lbSteps = lb.querySelector('.lb-steps')
  var side = lb.querySelector('.lb-side')
  var backdrop = lb.querySelector('.lb-backdrop')
  var currentIndex = -1
  var opener = null
  var EASE = 'cubic-bezier(.2,.8,.2,1)'

  function morph(fromRect, toRect, reverse) {
    var dx = fromRect.left - toRect.left
    var dy = fromRect.top - toRect.top
    var sx = fromRect.width / toRect.width
    var sy = fromRect.height / toRect.height
    var small = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')'
    var frames = [{ transform: small, borderRadius: '14px' }, { transform: 'none', borderRadius: '16px' }]
    if (reverse) frames.reverse()
    return frame.animate(frames, { duration: still ? 0 : 480, easing: EASE, fill: 'both' })
  }
  function fill(index) {
    var card = cards[index]
    var clip = card.dataset.clip
    lb.dataset.clip = clip
    lb.querySelector('#lb-title').innerHTML = card.querySelector('h3').innerHTML
    lb.querySelector('.lb-text').innerHTML = card.querySelector('.card-body > p[lang="en"]').outerHTML + card.querySelector('.card-body > p[lang="ko"]').outerHTML
    lbSteps.innerHTML = card.querySelector('.steps').innerHTML
    lbSteps.querySelectorAll('li').forEach(function (li) { li.classList.remove('now', 'done') })
    lbVideo.poster = card.querySelector('video').poster
    lbVideo.src = card.querySelector('video').dataset.src
    lbVideo.currentTime = 0
    lbVideo.play().catch(function () {})
  }
  function open(index) {
    var card = cards[index]
    card.querySelector('video').pause()
    opener = card
    currentIndex = index
    var from = card.querySelector('.thumb').getBoundingClientRect()
    lb.hidden = false
    document.body.classList.add('lb-open')
    fill(index)
    var to = frame.getBoundingClientRect()
    morph(from, to, false)
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: still ? 0 : 360, fill: 'both' })
    side.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
      { duration: still ? 0 : 420, delay: still ? 0 : 160, easing: EASE, fill: 'both' })
    lb.querySelector('.lb-close').focus({ preventScroll: true })
  }
  function close() {
    if (lb.hidden) return
    lbVideo.pause()
    var card = cards[currentIndex]
    var to = frame.getBoundingClientRect()
    var target = card.querySelector('.thumb').getBoundingClientRect()
    var anim = morph(target, to, true)
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 300, fill: 'both' })
    side.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 160, fill: 'both' })
    anim.onfinish = function () {
      lb.hidden = true
      document.body.classList.remove('lb-open')
      frame.getAnimations().forEach(function (a) { a.cancel() })
      lbVideo.removeAttribute('src')
      lbVideo.load()
      if (opener) opener.focus({ preventScroll: true })
    }
  }
  function go(step) {
    currentIndex = (currentIndex + step + cards.length) % cards.length
    opener = cards[currentIndex]
    frame.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: still ? 0 : 260 })
    fill(currentIndex)
  }
  lbVideo.addEventListener('timeupdate', function () {
    var li = highlight(lbSteps, lbVideo, lb.dataset.clip)
    var text = li ? li.querySelector('[lang="' + root.lang + '"]').textContent : ''
    if (caption.dataset.text !== text) {
      caption.dataset.text = text
      caption.textContent = text
      caption.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: still ? 0 : 280, easing: EASE })
    }
  })
  lbVideo.addEventListener('ended', function () { lbVideo.currentTime = 0; lbVideo.play().catch(function () {}) })
  lb.querySelectorAll('[data-close]').forEach(function (el) { el.addEventListener('click', close) })
  lb.querySelector('[data-prev]').addEventListener('click', function () { go(-1) })
  lb.querySelector('[data-next]').addEventListener('click', function () { go(1) })
  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight') go(1)
    else if (e.key === 'ArrowLeft') go(-1)
  })
})()
