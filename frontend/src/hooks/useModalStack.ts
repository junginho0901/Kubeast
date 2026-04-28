import { useCallback, useEffect, useRef } from 'react'

let stack: number[] = []
let nextId = 1

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

// 중첩된 모달이 떠 있을 때 부모 모달의 backdrop 클릭과 ESC가 같이 닫혀버리는
// 문제를 막기 위한 전역 modal stack. 모달이 활성화되면 자기 id를 push 하고,
// 핸들러에서 isTop()이 true 일 때만 닫기 동작을 수행하도록 한다.
export function useModalStackEntry(active: boolean = true): () => boolean {
  const idRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) return
    const id = push()
    idRef.current = id
    return () => {
      pop(id)
      idRef.current = null
    }
  }, [active])

  return useCallback(() => {
    return idRef.current !== null && isTopOf(idRef.current)
  }, [])
}
