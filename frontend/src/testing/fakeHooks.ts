// For unit tests (node, no DOM): React's hooks run across renders of a component or hook function called directly.
// States, refs and memos are kept by call order, effects run after a render when their dependencies changed (the
// previous cleanup first), and a render repeats while a state changed during it or its effects. A test mocks 'react'
// with { ...real React, ...fakeHooks } and renders with fakeRender; what a component returns is its element tree.

interface EffectSlot { deps?: readonly unknown[]; cleanup?: void | (() => void) }

const rt = {
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { deps?: readonly unknown[]; value: unknown }[],
  effects: [] as EffectSlot[],
  pending: [] as (() => void)[],
  at: { s: 0, r: 0, m: 0, e: 0 },
  dirty: false,
}

const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
  !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

function memoSlot<T>(make: () => T, deps?: readonly unknown[]): T {
  const at = rt.at.m++
  const slot = rt.memos[at]
  if (!slot || changed(slot.deps, deps)) rt.memos[at] = { deps, value: make() }
  return rt.memos[at].value as T
}

function effectSlot(effect: () => void | (() => void), deps?: readonly unknown[]) {
  const at = rt.at.e++
  const slot = rt.effects[at]
  if (slot && !changed(slot.deps, deps)) return
  rt.pending.push(() => {
    if (typeof slot?.cleanup === 'function') slot.cleanup()
    rt.effects[at] = { deps, cleanup: effect() }
  })
}

export const fakeHooks = {
  useState<T>(init: T | (() => T)) {
    const at = rt.at.s++
    if (!(at in rt.states)) rt.states[at] = typeof init === 'function' ? (init as () => T)() : init
    const set = (next: T | ((v: T) => T)) => {
      const value = typeof next === 'function' ? (next as (v: T) => T)(rt.states[at] as T) : next
      if (!Object.is(value, rt.states[at])) {
        rt.states[at] = value
        rt.dirty = true
      }
    }
    return [rt.states[at] as T, set] as const
  },
  useRef<T>(init: T) {
    const at = rt.at.r++
    rt.refs[at] ??= { current: init }
    return rt.refs[at] as { current: T }
  },
  useMemo: memoSlot,
  useCallback<T>(fn: T, deps?: readonly unknown[]): T {
    return memoSlot(() => fn, deps)
  },
  useEffect: effectSlot,
  useLayoutEffect: effectSlot,
}

// Calls `run` as React renders it: again while a state changed, effects after each pass. Returns the last output.
export function fakeRender<T>(run: () => T): T {
  for (let pass = 0; pass < 25; pass++) {
    rt.at = { s: 0, r: 0, m: 0, e: 0 }
    rt.dirty = false
    rt.pending = []
    const out = run()
    const effects = rt.pending
    rt.pending = []
    for (const effect of effects) effect()
    if (!rt.dirty) return out
  }
  throw new Error('the renders did not settle')
}

// Unmounts: runs the cleanups and forgets every state.
export function fakeUnmount() {
  for (const slot of rt.effects) if (typeof slot?.cleanup === 'function') slot.cleanup()
  rt.states = []
  rt.refs = []
  rt.memos = []
  rt.effects = []
  rt.pending = []
}

// Every text in an element tree (the element's children and the props that hold elements), in order.
export function textsOf(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  if (typeof node === 'object' && 'props' in (node as object)) {
    const props = (node as { props: Record<string, unknown> }).props
    return Object.entries(props).flatMap(([name, value]) => (name === 'children' || isElementish(value) ? textsOf(value) : []))
  }
  return []
}

// The elements of a tree whose props pass `match`, children first-found order.
export function elementsOf(node: unknown, match: (props: Record<string, unknown>, type: unknown) => boolean): { type: unknown; props: Record<string, unknown> }[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => elementsOf(n, match))
  if (!('props' in (node as object))) return []
  const el = node as { type: unknown; props: Record<string, unknown> }
  const here = match(el.props, el.type) ? [el] : []
  const inside = Object.entries(el.props).flatMap(([name, value]) => (name === 'children' || isElementish(value) ? elementsOf(value, match) : []))
  return [...here, ...inside]
}

function isElementish(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isElementish)
  return value !== null && typeof value === 'object' && 'props' in (value as object) && '$$typeof' in (value as object)
}
