import { describe, expect, it } from 'vitest'
import { takeLogLine, type ShownLine } from './podLogLines'

// What the Logs tab shows of the messages that come, added as PodLogsTab adds them.
function shown(messages: Array<[id: string, text: string]>): string[] {
  let last: ShownLine | null = null
  const out: string[] = []
  for (const [id, text] of messages) {
    const next = takeLogLine(last, id, text)
    if (!next) continue
    last = next
    out.push(text)
  }
  return out
}

// A message as k8s-service sends a line: id "<stamp>#<place among the lines of that stamp>", data the line.
const line = (stamp: string, place: number, text: string): [string, string] =>
  [`2026-11-09T05:58:${stamp}Z#${place}`, `2026-11-09T05:58:${stamp}Z ${text}`]
const text = (stamp: string, words: string) => `2026-11-09T05:58:${stamp}Z ${words}`

const FIRST = [line('05.100000000', 1, 'one'), line('05.300000000', 1, 'two'), line('05.300000000', 2, 'two-b')]
const ALL = [text('05.100000000', 'one'), text('05.300000000', 'two'), text('05.300000000', 'two-b'), text('05.300000000', 'two-c'), text('06.200000000', 'three')]

describe('a followed log that reconnects', () => {
  it('adds the lines after the last one when the server goes on from it', () => {
    expect(shown([...FIRST, line('05.300000000', 3, 'two-c'), line('06.200000000', 1, 'three')])).toEqual(ALL)
  })

  it('shows no line twice and loses none after it when the server starts over with the tail', () => {
    const tailAgain = [...FIRST, line('05.300000000', 3, 'two-c'), line('06.200000000', 1, 'three')]
    expect(shown([...FIRST, ...tailAgain])).toEqual(ALL)
  })

  it('orders places past nine by number, not as text', () => {
    const lines = [line('05.3', 2, 'a'), line('05.3', 9, 'b'), line('05.3', 10, 'c')]
    expect(shown([...lines, line('05.3', 9, 'b'), line('05.3', 10, 'c'), line('05.3', 11, 'd')])).toEqual(
      [text('05.3', 'a'), text('05.3', 'b'), text('05.3', 'c'), text('05.3', 'd')],
    )
  })
})

describe('a followed log whose lines carry no id the tab reads', () => {
  it('shows every line of a server that sends no ids', () => {
    const lines: Array<[string, string]> = [['', 'one'], ['', 'two'], ['', 'one'], ['', 'three']]
    expect(shown(lines)).toEqual(['one', 'two', 'one', 'three'])
  })

  // EventSource gives a message with no id the last id it had, so after a reconnect to such a server every line
  // carries the id of the line shown last: only that line itself is left out.
  it('keeps showing lines after a reconnect to a server that sends no ids', () => {
    const repeated = FIRST[2][0]
    const after: Array<[string, string]> = [[repeated, text('05.300000000', 'two')], [repeated, text('05.300000000', 'two-b')], [repeated, 'four']]
    expect(shown([...FIRST, ...after])).toEqual([...ALL.slice(0, 3), text('05.300000000', 'two'), 'four'])
  })

  it('shows lines whose ids it cannot read', () => {
    expect(shown([['x', 'one'], ['x', 'one'], ['y#z', 'two']])).toEqual(['one', 'one', 'two'])
  })
})
