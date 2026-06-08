import { useCallback, useLayoutEffect, useRef, useState } from 'react'

let stack: number[] = []
let nextId = 1

// Base z-index for the first (bottom-most) modal; each nested modal stacks
// Z_STEP above the one it opened over. Keeps the first modal at the previous
// fixed value (1200) so non-modal overlays (e.g. the floating chat) are
// unaffected.
const Z_BASE = 1200
const Z_STEP = 10

function push(): number {
  const id = nextId++
  stack.push(id)
  return id
}

function pop(id: number): void {
  stack = stack.filter((x) => x !== id)
}

function isTopOf(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

function indexOf(id: number): number {
  return stack.indexOf(id)
}

export interface ModalStackEntry {
  // True only when this modal is the top-most — used so a parent modal's
  // backdrop click / ESC doesn't also fire while a child modal is open.
  isTop: () => boolean
  // z-index assigned by open order so a modal opened from another (e.g. the
  // detail drawer opened from a list modal) renders ABOVE its opener, while a
  // dialog opened from it (e.g. a delete confirm) renders above it in turn.
  zIndex: number
}

// 중첩된 모달이 떠 있을 때 부모 모달의 backdrop 클릭/ESC 가 같이 닫혀버리는 것을
// 막고(스택 top 만 닫기), 열린 순서대로 z-index 를 쌓기 위한 전역 modal stack.
export function useModalStackEntry(active: boolean = true): ModalStackEntry {
  const idRef = useRef<number | null>(null)
  const [depth, setDepth] = useState(0)

  // useLayoutEffect so the depth (→ z-index) is set before paint — a drawer
  // opened over a list modal must not flash behind it for a frame.
  useLayoutEffect(() => {
    if (!active) return
    const id = push()
    idRef.current = id
    setDepth(indexOf(id))
    return () => {
      pop(id)
      idRef.current = null
    }
  }, [active])

  const isTop = useCallback(() => {
    return idRef.current !== null && isTopOf(idRef.current)
  }, [])

  return { isTop, zIndex: Z_BASE + depth * Z_STEP }
}
