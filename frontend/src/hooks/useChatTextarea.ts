import { useLayoutEffect, useRef, type CompositionEvent, type KeyboardEvent, type RefObject } from 'react'

// A textarea that grows with its text (Shift+Enter lines) up to maxHeight px and scrolls beyond it; it shrinks
// back when the text gets shorter or is cleared after sending.
export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxHeight: number) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cs = getComputedStyle(el)
    const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    el.style.height = 'auto'
    const wanted = el.scrollHeight + borders
    el.style.height = `${Math.min(wanted, maxHeight)}px`
    el.style.overflowY = wanted > maxHeight ? 'auto' : 'hidden'
  }, [ref, value, maxHeight])
}

// Enter sends, Shift+Enter adds a line. The line is inserted here rather than left to the browser, because with
// a Korean/Japanese/Chinese input method a Shift+Enter pressed while a syllable is still being composed is not
// reliable: Windows reports the key as "Process" and inserts nothing, Chrome on macOS can fire the keydown twice
// (once composing, once not), and Safari ends the composition before the keydown. Pressed mid-composition, the
// line goes in after compositionend, and a second keydown of that press is ignored.
export function useChatTextareaKeys(
  ref: RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string) => void,
  onEnter: () => void,
) {
  const pending = useRef(false)
  const handledAt = useRef(0)

  const insertNewline = () => {
    const el = ref.current
    if (!el) return
    el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end')
    onChange(el.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const enter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter'
    const composing = e.nativeEvent.isComposing || e.key === 'Process' || e.keyCode === 229
    if (enter && e.shiftKey) {
      e.preventDefault()
      if (composing) {
        pending.current = true
      } else if (performance.now() - handledAt.current > 100) {
        pending.current = false
        insertNewline()
      }
      return
    }
    if (composing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      onEnter()
    }
  }

  const onCompositionEnd = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    if (!pending.current) return
    pending.current = false
    handledAt.current = performance.now()
    setTimeout(insertNewline, 0) // after the input method has put the composed text in
  }

  return { onKeyDown, onCompositionEnd }
}
