// What the demo says on top of the released screens: a short line after a write ("nothing really changes") or an action
// the demo has not prepared, and the prepared questions after a question it cannot answer. Plain DOM, outside React.

let current: 'ko' | 'en' = (() => {
  const query = location.hash.split('?')[1] || location.search.slice(1)
  const asked = new URLSearchParams(query).get('lang')
  if (asked === 'ko' || asked === 'en') return asked
  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en'
})()
export const lang = () => current
export const setLang = (next: string) => { current = next.toLowerCase().startsWith('ko') ? 'ko' : 'en' }

const words = {
  demo: { ko: '체험판 — 실제로 바뀌지 않음', en: 'Demo — nothing really changes' },
  unsupported: { ko: '체험판에서는 지원하지 않습니다', en: 'Not supported in the demo' },
  prepared: { ko: '준비된 질문', en: 'Prepared questions' },
  close: { ko: '닫기', en: 'Close' },
  terminal: {
    ko: '체험판에는 연결된 클러스터가 없어 이 창에서 터미널을 열 수 없습니다. 실제 설치에서는 여기에 컨테이너의 셸이 열립니다.',
    en: 'The demo has no cluster behind it, so terminals are not available here. In a real install this window opens a shell in the container.',
  },
}
// What a terminal window (pod exec, node shell) shows in the demo, in its own lines: a note, not an error.
export const terminalNote = () => words.terminal[current]

function styles() {
  if (document.getElementById('demo-notice-style')) return
  const style = document.createElement('style')
  style.id = 'demo-notice-style'
  style.textContent = [
    '.demo-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483000;max-width:calc(100% - 32px);padding:10px 16px;border-radius:10px;background:#0b2230;border:1px solid #5fd0e6;color:#e6f7fb;font:500 14px/1.4 InterVariable,system-ui,sans-serif;box-shadow:0 10px 30px #0008;transition:opacity .2s}',
    '.demo-toast[data-kind=unsupported]{border-color:#94a3b8}',
    '.demo-chips{position:fixed;left:16px;right:16px;bottom:96px;z-index:2147482000;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-radius:12px;background:#0f1b26f2;border:1px solid #2f6d84;font:13px/1.4 InterVariable,system-ui,sans-serif;color:#cfe6ef}',
    // beside AI Chat's conversation list (16rem), which a phone's screen does not have
    'html:not(.tour-phone) .demo-chips{left:calc(16rem + 16px)}',
    '.demo-chips b{font-weight:600;margin-right:4px}',
    '.demo-chips button{font:inherit;padding:6px 10px;border-radius:999px;border:1px solid #3d7f96;background:#13303f;color:#e6f7fb;cursor:pointer;text-align:left}',
    '.demo-chips button:hover,.demo-chips button:focus-visible{background:#1b4458;outline:2px solid #7dd3fc;outline-offset:1px}',
    '.demo-chips .demo-chips-close{margin-left:auto;border-radius:8px;border-color:transparent;background:transparent}',
    '@media (prefers-reduced-motion: reduce){.demo-toast{transition:none}}',
  ].join('\n')
  document.head.appendChild(style)
}

let toastTimer = 0
export function notice(kind: 'demo' | 'unsupported') {
  styles()
  let toast = document.getElementById('demo-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'demo-toast'
    toast.className = 'demo-toast'
    toast.setAttribute('role', 'status')
    toast.setAttribute('aria-live', 'polite')
    document.body.appendChild(toast)
  }
  toast.dataset.kind = kind
  toast.textContent = words[kind][current]
  toast.style.opacity = '1'
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { if (toast) toast.style.opacity = '0' }, 3200)
}

// Puts a prepared question into the chat's own input and sends it, as a person typing it would.
function ask(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
  if (!box) return
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setValue?.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.focus()
  window.setTimeout(() => box.parentElement?.querySelector<HTMLButtonElement>('button:not([disabled])')?.click(), 80)
}

export function hideSuggestions() {
  document.getElementById('demo-chips')?.remove()
}

export function showSuggestions(questions: string[]) {
  styles()
  hideSuggestions()
  const bar = document.createElement('div')
  bar.id = 'demo-chips'
  bar.className = 'demo-chips'
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', words.prepared[current])
  const title = document.createElement('b')
  title.textContent = words.prepared[current]
  bar.appendChild(title)
  for (const q of questions) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.textContent = q
    chip.addEventListener('click', () => { hideSuggestions(); ask(q) })
    bar.appendChild(chip)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'demo-chips-close'
  close.textContent = '×'
  close.setAttribute('aria-label', words.close[current])
  close.addEventListener('click', hideSuggestions)
  bar.appendChild(close)
  bar.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); hideSuggestions() } })
  document.body.appendChild(bar)
}
