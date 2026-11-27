import { describe, expect, it } from 'vitest'
import { focusDropped, refocusIfDropped } from './focusDrop'

type El = Element & { focus(): void }
function page() {
  const doc = { activeElement: null as Element | null, body: null as Element | null }
  const el = (name: string) => {
    const e = { name, isConnected: true, focus: () => { doc.activeElement = e as unknown as Element } }
    return e as unknown as El & { name: string; isConnected: boolean }
  }
  doc.body = el('body')
  doc.activeElement = doc.body
  return { doc, el }
}

describe('a focus that fell to the page', () => {
  it('is on the body, on nothing, or on an element no longer in the page', () => {
    const { doc, el } = page()
    expect(focusDropped(doc)).toBe(true)
    doc.activeElement = null
    expect(focusDropped(doc)).toBe(true)
    const gone = el('Edit')
    doc.activeElement = gone
    gone.isConnected = false
    expect(focusDropped(doc)).toBe(true)
    gone.isConnected = true
    expect(focusDropped(doc)).toBe(false)
  })

  it('goes to the next place, and a focus the reader put somewhere stays', () => {
    const { doc, el } = page()
    const next = el('Apply')
    expect(refocusIfDropped(doc, next)).toBe(true)
    expect(doc.activeElement).toBe(next)
    const elsewhere = el('search')
    elsewhere.focus()
    expect(refocusIfDropped(doc, next)).toBe(false)
    expect(doc.activeElement).toBe(elsewhere)
  })
})
