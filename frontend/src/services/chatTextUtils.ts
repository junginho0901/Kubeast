// AI Chat 메시지 텍스트 가공 유틸.
//
// chatStreamManager.ts 가 streaming 중 message.content 에 다음 형태로 tool 호출
// 메타정보를 박는다 (UI 에서 <details> 로 접힘):
//
//   <details><summary>🔧 toolName</summary>
//     <details><summary>📋 Arguments</summary>...</details>
//     <details><summary>📊 Results</summary>...</details>
//   </details>
//
//   여기부터 진짜 답변 markdown ...
//
// 사용자가 "Copy" 버튼을 누르면 message.content 가 그대로 clipboard 로 가서
// HTML 태그 + JSON args + tool 결과가 다 섞여 복사됨. 답변만 가져오고 싶을 때
// 이 유틸로 outer <details> block 들을 제거한다.

const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,})[^\n]*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/
const TOOL_BLOCK_START = /<details>[ \t\r\n]*<summary>🔧/g
const DETAILS_TAG = /<\/?details>/g

function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at)
  return end === -1 ? text.length : end
}

const indentOf = (line: string) => line.length - line.trimStart().length
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/

// Whether the fence at `at`, indented so far, sits under a list item: the nearest less indented line above is its marker.
function inListItem(text: string, at: number, indent: number): boolean {
  let end = at - 1
  while (end >= 0) {
    const start = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    if (line.trim() && indentOf(line) < indent) return LIST_ITEM.test(line)
    if (start === 0) return false
    end = start - 1
  }
  return false
}

/**
 * A reader of a text's fenced code blocks, by CommonMark's rules (backticks or tildes, up to three spaces in, closed by
 * a line of the same mark at least as long): given the start of a line, moving forward, where the block that opens there
 * ends, or -1. A fence nothing closes is no block: an answer saved before results got their longer fence can hold an odd
 * line of backticks, and reading the rest of it as code would lose the answer after it. A line less indented than a
 * fence under a list item ends the item, and the fence with it.
 */
export function fenceReader(text: string): (at: number) => number {
  // the shortest fence of each mark seen with no closing line after it, so a text of open fences stays one pass
  const unclosed: Record<string, number> = {}
  return (at) => {
    const opening = text.slice(at, lineEnd(text, at))
    const open = FENCE_OPEN.exec(opening)
    const fence = open?.[1] ?? open?.[2]
    if (!fence || fence.length >= (unclosed[fence[0]] ?? Infinity)) return -1
    const indent = indentOf(opening)
    let line = lineEnd(text, at) + 1
    while (line <= text.length) {
      const end = lineEnd(text, line)
      const body = text.slice(line, end)
      const close = FENCE_CLOSE.exec(body)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) return Math.min(end + 1, text.length)
      if (body.trim() && indentOf(body) < indent && inListItem(text, at, indent)) return line
      line = end + 1
    }
    unclosed[fence[0]] = fence.length
    return -1
  }
}

/**
 * The line that closes the code block `text` leaves open, or null. A tool block below an open one reads as code. A fence
 * with a less indented line after it was in a list item that line ended, and a closing line there would open a new block
 * (ai-service formatters.closing_fence does the same, chatAnswer.cases.json holds the two equal).
 */
export function closingFence(text: string): string | null {
  const fenceEnd = fenceReader(text)
  let at = 0
  while (at < text.length) {
    const end = fenceEnd(at)
    if (end !== -1) {
      at = end
      continue
    }
    const next = lineEnd(text, at)
    const line = text.slice(at, next)
    const open = FENCE_OPEN.exec(line)
    if (open) {
      const indent = indentOf(line)
      const ended = text.slice(next).split('\n').some((after) => after.trim() && indentOf(after) < indent)
      if (!ended) return ' '.repeat(indent) + (open[1] ?? open[2])
    }
    at = next + 1
  }
  return null
}

function codeBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = []
  const fenceEnd = fenceReader(text)
  let at = 0
  while (at < text.length) {
    const end = fenceEnd(at)
    if (end !== -1) blocks.push([at, end])
    at = end !== -1 ? end : lineEnd(text, at) + 1
  }
  return blocks
}

// The end of the code block `at` is in, else -1; `at` only moves forward.
function codeEndReader(text: string): (at: number) => number {
  const blocks = codeBlocks(text)
  let inBlock = 0
  return (at) => {
    while (inBlock < blocks.length && blocks[inBlock][1] <= at) inBlock++
    return inBlock < blocks.length && blocks[inBlock][0] <= at ? blocks[inBlock][1] : -1
  }
}

// Where the tool block starting at `start` ends, or -1 if it does not. Tags inside a code block do not count.
function toolBlockEnd(text: string, start: number, codeEnd: (at: number) => number): number {
  let depth = 0
  let at = start
  for (;;) {
    DETAILS_TAG.lastIndex = at
    const tag = DETAILS_TAG.exec(text)
    if (!tag) return -1
    const inCode = codeEnd(tag.index)
    if (inCode !== -1) {
      at = inCode
      continue
    }
    at = tag.index + tag[0].length
    depth += tag[0] === '<details>' ? 1 : -1
    if (depth === 0) return at
  }
}

// What Markdown reads from anywhere in a document, so a block above can hang on a line below it.
const READ_FROM_ANYWHERE = /^ {0,3}\[[^\]\n]+\]:|\[\^/m
const TOOL_BLOCK_HERE = /<details>[ \t\r\n]*<summary>🔧/y
const STARTS_LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

const blankLine = (text: string, at: number) => !text.slice(at, lineEnd(text, at)).trim()

// Whether a stretch of text has a fence line that closes nothing: Markdown reads all that follows as code, answers saved
// before results got their longer fence hold one.
function holdsOpenFence(text: string, from: number, to: number): boolean {
  const codeEnd = codeEndReader(text)
  let at = from
  while (at < to) {
    const code = codeEnd(at)
    if (code !== -1) {
      at = code
      continue
    }
    if (FENCE_OPEN.test(text.slice(at, lineEnd(text, at)))) return true
    at = lineEnd(text, at) + 1
  }
  return false
}

/**
 * An answer cut into the pieces that draw the same as the whole, so what is settled is not parsed again while the rest
 * comes. A piece ends at a blank line outside code, before a line that starts a block of its own (a list item may belong
 * to the list above it), and a tool block is a piece. From a raw `<`, an open fence or an indented fence on, the answer
 * stays one piece: HTML takes in what follows it. A definition or a footnote keeps the whole answer one piece.
 */
export function answerChunks(text: string): string[] {
  if (!text) return []
  if (READ_FROM_ANYWHERE.test(text)) return [text]
  const codeEnd = codeEndReader(text)
  const chunks: string[] = []
  let start = 0
  let at = 0
  while (at < text.length) {
    const code = codeEnd(at)
    if (code !== -1) {
      // an indented fence is the one place the reader and Markdown can pair fences differently
      if (text[at] === ' ') break
      at = code
      continue
    }
    const end = lineEnd(text, at)
    TOOL_BLOCK_HERE.lastIndex = at
    if (TOOL_BLOCK_HERE.test(text)) {
      const blockEnd = toolBlockEnd(text, at, codeEnd)
      if (blockEnd === -1 || !blankLine(text, blockEnd) || holdsOpenFence(text, at, blockEnd)) break
      let after = lineEnd(text, blockEnd) + 1
      // a line right under an HTML block is part of it
      if (after < text.length && !blankLine(text, after)) break
      while (after < text.length && blankLine(text, after)) after = lineEnd(text, after) + 1
      if (at > start) chunks.push(text.slice(start, at))
      chunks.push(text.slice(at, Math.min(after, text.length)))
      start = at = Math.min(after, text.length)
      continue
    }
    const line = text.slice(at, end)
    if (line.includes('<') || FENCE_OPEN.test(line)) break
    if (!line.trim()) {
      let following = end + 1
      while (following < text.length && blankLine(text, following)) following = lineEnd(text, following) + 1
      if (following >= text.length) break
      const next = text.slice(following, lineEnd(text, following))
      if (at > start && !/^\s/.test(next) && !STARTS_LIST_ITEM.test(next)) {
        chunks.push(text.slice(start, following))
        start = following
      }
      at = following
      continue
    }
    at = end + 1
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks
}

/**
 * `<details><summary>🔧 ...</summary>...</details>` outer block 들을 모두 제거.
 *
 * Nested `<details>` 안전 처리를 위해 depth counting 으로 outer 의 닫는 태그를
 * 정확히 매칭한다 (정규식 non-greedy 만으로는 inner 의 첫 `</details>` 에 잘못
 * 매칭됨). Tags inside a code block are a result's or the answer's words and do not count, and a block
 * starts on a line of its own, as the stream and the server write it (ai-service strip_tool_blocks does the same,
 * chatTextUtils.cases.json holds the two equal).
 *
 * 🔧 마커가 없는 일반 `<details>` 는 건드리지 않는다 — 답변 본문에 사용자가
 * 의도적으로 넣은 details 가 있을 수 있음.
 */
export function stripToolDetails(text: string): string {
  if (!text) return text
  const codeEnd = codeEndReader(text)

  let result = ''
  let i = 0
  for (;;) {
    TOOL_BLOCK_START.lastIndex = i
    const start = TOOL_BLOCK_START.exec(text)
    if (!start) return result + text.slice(i)
    const code = codeEnd(start.index)
    if (code !== -1 || (start.index > 0 && text[start.index - 1] !== '\n')) {
      const next = code !== -1 ? code : start.index + 1
      result += text.slice(i, next)
      i = next
      continue
    }
    result += text.slice(i, start.index)

    // depth counting 으로 outer 닫는 위치 찾기
    const end = toolBlockEnd(text, start.index, codeEnd)

    // outer 영역 skip + 직후 trailing 공백·개행 skip (block 사이 \n\n
    // 가 chatStreamManager 에서 추가됨 — 답변 시작 전 공백 정리)
    i = end === -1 ? text.length : end
    while (i < text.length && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t')) {
      i++
    }
  }
}
