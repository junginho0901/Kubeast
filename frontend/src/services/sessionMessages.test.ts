import { describe, expect, it } from 'vitest'

import { hiddenEarlier, mergeNewestPage, olderThanNewestPage, prependEarlier } from './sessionMessages'

const m = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }))
const ids = (list: { id?: number | string }[]) => list.map((x) => x.id)
const first = (list: { id?: number | string }[]) => list[0]?.id
const last = (list: { id?: number | string }[]) => list[list.length - 1]?.id

describe('a conversation longer than one page', () => {
  it('says how many of its messages the screen does not hold', () => {
    // 150 messages, the newest 100 on screen
    expect(hiddenEarlier({ messages_before: 50, messages: m(51, 150) }, m(51, 150))).toBe(50)
    // one page read above them
    expect(hiddenEarlier({ messages_before: 150, messages: m(151, 250) }, m(51, 250))).toBe(50)
    expect(hiddenEarlier({ messages_before: 150, messages: m(151, 250) }, m(1, 250))).toBe(0)
    expect(hiddenEarlier({ messages_before: 0, messages: m(1, 3) }, m(1, 3))).toBe(0)
  })

  it('counts every earlier message while the answer has not reached the screen', () => {
    expect(hiddenEarlier({ messages_before: 50, messages: m(51, 150) }, [])).toBe(50)
    expect(hiddenEarlier(undefined, m(1, 3))).toBe(0)
    expect(hiddenEarlier({ messages: m(1, 3) }, m(1, 3))).toBe(0)
  })

  it('keeps the count right when the newest page moves on after a new turn', () => {
    // two new messages: the page moved from 51-150 to 53-152; 51 and 52 stay on screen
    const shown = mergeNewestPage(m(51, 150), m(53, 152))
    expect(hiddenEarlier({ messages_before: 52, messages: m(53, 152) }, shown)).toBe(50)
  })

  it('a page of earlier messages goes above the list, each message once', () => {
    expect(ids(prependEarlier(m(51, 53), m(49, 50)))).toEqual([49, 50, 51, 52, 53])
    expect(ids(prependEarlier(m(51, 53), m(50, 51)))).toEqual([50, 51, 52, 53])
    expect(ids(prependEarlier(m(51, 53), []))).toEqual([51, 52, 53])
  })

  it('the newest page does not take the earlier messages off the screen', () => {
    const shown = mergeNewestPage(m(1, 150), m(51, 150))
    expect(shown.length).toBe(150)
    expect([first(shown), last(shown)]).toEqual([1, 150])
  })

  it('messages that left the newest page stay on the screen, in order, without a gap', () => {
    const shown = mergeNewestPage(m(1, 150), m(53, 152))
    expect(shown.length).toBe(152)
    expect([first(shown), shown[51].id, shown[52].id, last(shown)]).toEqual([1, 52, 53, 152])
  })

  it('a turn on a full page reads as saved once both its messages are: the list as long as the screen', () => {
    // 100 on screen plus the turn's two temporary bubbles
    const screen = [...m(51, 150), { id: undefined }, { id: undefined }]
    // nothing saved yet, the question saved, then the answer too
    expect(mergeNewestPage(screen, m(51, 150)).length).toBeLessThan(screen.length)
    expect(mergeNewestPage(screen, m(52, 151)).length).toBeLessThan(screen.length)
    expect(mergeNewestPage(screen, m(53, 152)).length).toBe(screen.length)
  })

  it('temporary bubbles give way to what was saved', () => {
    const onScreen: { id?: number | string }[] = [{ id: undefined }, { id: 'pending-user-1' }]
    expect(ids(mergeNewestPage(onScreen, m(1, 2)))).toEqual([1, 2])
    expect(ids(mergeNewestPage(onScreen, []))).toEqual([])
  })

  it('a newest page that no longer meets the screen replaces it, and the count says the rest', () => {
    const shown = mergeNewestPage(m(1, 100), m(201, 300))
    expect([first(shown), last(shown), shown.length]).toEqual([201, 300, 100])
    expect(hiddenEarlier({ messages_before: 200, messages: m(201, 300) }, shown)).toBe(200)
  })

  it('knows a message on screen that the newest page does not hold', () => {
    expect(olderThanNewestPage(10, m(51, 150))).toBe(true)
    expect(olderThanNewestPage(51, m(51, 150))).toBe(false)
    expect(olderThanNewestPage(undefined, m(51, 150))).toBe(false)
    expect(olderThanNewestPage(10, [])).toBe(false)
  })
})
