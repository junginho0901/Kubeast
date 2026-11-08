import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { CHAT_MARKDOWN } from '@/components/chatMarkdown'
import { AnswerChunk, ChatAnswerMarkdown } from '@/components/ChatAnswerMarkdown'
import { MessageList } from '@/components/FloatingAIChat/MessageList'
import { MessageBubble } from '@/pages/ai-chat/MessageBubble'
import ANSWERS from '@/services/chatAnswer.cases.json'
import { answerChunks } from '@/services/chatTextUtils'
import TEXTS from '@/services/chatTextUtils.cases.json'

// An answer on its way is drawn every few milliseconds. What is settled is not parsed again, so a long answer costs what
// its last paragraph costs: this holds the pieces to the one document they stand for, in every shape an answer takes.

// The spaces between blocks draw nothing; those in a code block are its letters.
const tags = (html: string) =>
  html.split(/(<pre[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.replace(/>\s+/g, '>').replace(/\s+</g, '<'))).join('').trim()
const whole = (text: string) => tags(renderToStaticMarkup(createElement(ReactMarkdown, { ...CHAT_MARKDOWN, children: text })))
const pieces = (text: string) => tags(renderToStaticMarkup(createElement(ChatAnswerMarkdown, { content: text })))

const TOOL = ANSWERS.block
const SHAPES: [string, string][] = [
  ['paragraphs', 'One.\n\nTwo.\n\nThree.'],
  ['a heading and paragraphs', '# Title\n\nText.\n\n## Next\n\nMore text.'],
  ['a setext heading', 'Title\n=====\n\nText.\n\n===\n\nMore.'],
  ['a rule', 'One.\n\n---\n\nTwo.'],
  ['a tight list then text', '- a\n- b\n\nAfter.'],
  ['a loose list', '- a\n\n- b\n\n- c\n\nAfter.'],
  ['a numbered list across paragraphs', '1. a\n\n2. b\n\n3. c'],
  ['a numbered list from its own number', 'Text.\n\n5. a\n6. b\n\nAfter.'],
  ['a list item with a paragraph and a code block', '- a\n\n  more of a\n\n  ```\n  code\n\n  more code\n  ```\n\n- b\n\nAfter.'],
  ['a nested list', '- a\n  - b\n\n    c\n- d\n\nAfter.'],
  ['a task list', '- [x] done\n- [ ] not\n\nAfter.'],
  ['a table', 'Text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.'],
  ['a quote', '> one\n> two\n\n> three\n\nAfter.'],
  ['indented code', 'Text.\n\n    code\n\n    more code\n\nAfter.'],
  ['a closed code block with blank lines', 'Text.\n\n```\none\n\ntwo\n\n<details>\n```\n\nAfter.'],
  ['a code block left open', 'Text.\n\n```bash\none\n\ntwo\n\nthree'],
  ['tildes left open after a closed one', '```\na\n```\n\nb\n\n~~~\nc\n\nd'],
  ['a tool block between paragraphs', `One.\n\nTwo.\n\n${TOOL}Three.\n\nFour.`],
  ['two tool blocks', `${TOOL}${TOOL}After.`],
  ['a tool block with text right under it', `One.\n\n${TOOL.trimEnd()}\nRight under.\n\nFour.`],
  ['a tool block left open', 'One.\n\n<details>\n<summary>🔧 <strong>t</strong></summary>\n\nmore\n\nand more'],
  ['a reference link used above its definition', 'See [the docs][d].\n\nMore.\n\n[d]: https://example.test/\n\nAfter.'],
  ['a footnote', 'A fact[^1].\n\nMore.\n\n[^1]: The note.\n\nAfter.'],
  ['HTML around paragraphs', 'One.\n\n<div>\n\ntwo\n\nthree\n\n</div>\n\nFour.'],
  ['a details the answer wrote', 'One.\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n\nFour.'],
  ['a comment left open', 'One.\n\n<!-- open\n\nTwo.\n\nThree.'],
  ['a pre left open', 'One.\n\n<pre>\n\nTwo.\n\nThree.'],
  ['an element left open in a sentence', 'One <b>two\n\nThree.\n\nFour.'],
  ['a link left open around blocks', '<a href="https://example.test/">\n\n# Head\n\nText.'],
  ['a less than sign in a sentence', 'a < b\n\nc > d\n\nDone.'],
  ['tags a table or the page owns, on a line of their own', 'One.\n\n<col>\n\nTwo.\n\n<td>x</td>\n\nThree.\n\n<tr>\n\nFour.\n\n<li>y\n\nFive.'],
  ['tags that take what follows', 'One.\n\n<template>\n\nTwo.\n\n<select>\n\nThree.\n\n<table>\n\nFour.'],
  ['tags of a whole page', 'One.\n\n<html>\n\n<head>\n\n<title>t</title>\n\n<body>\n\nTwo.\n\n<frameset>\n\nThree.'],
  ['a tag closing what nothing opened', 'One.\n\n</div>\n\nTwo.\n\n</details>\n\nThree.'],
  ['a tool block after a tag left open', `One <b>two\n\n${TOOL}Three.`],
  ['a link around a tool block', `<a href="https://example.test/">\n\n${TOOL}Three.`],
  ['blank lines first and last', '\n\nOne.\n\n\n\nTwo.\n\n'],
  ['a line with only spaces between paragraphs', 'One.\n   \nTwo.'],
  ['nothing', ''],
]

describe('the pieces of an answer draw what the whole answer draws', () => {
  it.each(SHAPES)('%s', (_name, text) => {
    expect(pieces(text)).toBe(whole(text))
  })

  it.each(ANSWERS.cases.map((c) => [c.name, c.answer.replaceAll('{block}', TOOL)]))('answer: %s', (_name, text) => {
    expect(pieces(text)).toBe(whole(text))
  })

  it.each(TEXTS.map((c) => [c.name, c.text]))('text: %s', (_name, text) => {
    expect(pieces(text)).toBe(whole(text))
  })

  // while it comes, letter by letter
  it.each(SHAPES.filter(([, text]) => text.length > 0))('at every length: %s', (_name, text) => {
    for (let n = 1; n <= text.length; n += 3) expect(pieces(text.slice(0, n)), text.slice(0, n)).toBe(whole(text.slice(0, n)))
  })

  it('in any order of those shapes', () => {
    // the same order on every run, so a failure can be read again
    let seed = 20261107
    const pick = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const text = Array.from({ length: 2 + pick(5) }, () => SHAPES[pick(SHAPES.length)][1]).join(pick(4) === 0 ? '\n' : '\n\n')
      expect(pieces(text), JSON.stringify(text)).toBe(whole(text))
    }
  })
})

describe('the pieces of an answer', () => {
  const para = (n: number) => `Paragraph ${n} says what is going on with **node-${n}**.`

  it('hold every letter, in order', () => {
    for (const [, text] of SHAPES) expect(answerChunks(text).join('')).toBe(text)
  })

  it('leave only what is still changing in the last piece of a long answer', () => {
    const text = Array.from({ length: 200 }, (_, i) => para(i)).join('\n\n')
    const chunks = answerChunks(text)
    expect(chunks).toHaveLength(200)
    expect(chunks.at(-1)).toBe(para(199))
  })

  it('do not change those above as the answer grows', () => {
    const text = `${para(1)}\n\n${TOOL}${para(2)}\n\n${para(3)}\n\n${para(4)}`
    const settled = answerChunks(text).slice(0, -1)
    for (let n = text.length - para(4).length + 1; n <= text.length; n++) expect(answerChunks(text.slice(0, n)).slice(0, -1)).toEqual(settled)
  })

  it('give a tool block a piece of its own, so filling in its result parses that piece alone', () => {
    const chunks = answerChunks(`Before.\n\n${TOOL}After.`)
    expect(chunks).toEqual(['Before.\n\n', TOOL, 'After.'])
  })

  it('keep a whole document where something below could change what is above', () => {
    for (const text of ['See [d].\n\nMore.\n\n[d]: https://example.test/', 'A fact[^1].\n\nMore.\n\n[^1]: The note.']) expect(answerChunks(text)).toEqual([text])
  })

  it('keep the rest as one from where they stop being sure', () => {
    expect(answerChunks('One.\n\nTwo <b>x\n\nThree.\n\nFour.')).toEqual(['One.\n\n', 'Two <b>x\n\nThree.\n\nFour.'])
    expect(answerChunks('One.\n\n```\ncode\n\nmore')).toEqual(['One.\n\n', '```\ncode\n\nmore'])
    expect(answerChunks('One.\n\nDo this:\n\n   ```\n   code\n   ```\n\nTwo.\n\nThree.')).toEqual(['One.\n\n', 'Do this:\n\n   ```\n   code\n   ```\n\nTwo.\n\nThree.'])
  })
})

const MEMO = Symbol.for('react.memo')

describe('what does not change is not drawn again', () => {
  it('a piece of an answer', () => {
    expect((AnswerChunk as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO)
  })

  it('a bubble of AI Chat', () => {
    expect((MessageBubble as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO)
  })

  it('both chats draw an answer in pieces', () => {
    const text = 'One.\n\nTwo.'
    const floating = renderToStaticMarkup(createElement(MessageList, { messages: [{ role: 'assistant', content: text }] }))
    expect(floating).toContain('<p>One.</p><p>Two.</p>')
  })
})
