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

/**
 * A reader of a text's fenced code blocks, by CommonMark's rules (backticks or tildes, up to three spaces in, closed by
 * a line of the same mark at least as long): given the start of a line, moving forward, where the block that opens there
 * ends, or -1. A fence nothing closes is no block: an answer saved before results got their longer fence can hold an odd
 * line of backticks, and reading the rest of it as code would lose the answer after it.
 */
export function fenceReader(text: string): (at: number) => number {
  // the shortest fence of each mark seen with no closing line after it, so a text of open fences stays one pass
  const unclosed: Record<string, number> = {}
  return (at) => {
    const open = FENCE_OPEN.exec(text.slice(at, lineEnd(text, at)))
    const fence = open?.[1] ?? open?.[2]
    if (!fence || fence.length >= (unclosed[fence[0]] ?? Infinity)) return -1
    let line = lineEnd(text, at) + 1
    while (line <= text.length) {
      const end = lineEnd(text, line)
      const close = FENCE_CLOSE.exec(text.slice(line, end))?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) return Math.min(end + 1, text.length)
      line = end + 1
    }
    unclosed[fence[0]] = fence.length
    return -1
  }
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
  const blocks = codeBlocks(text)
  let inBlock = 0
  // the end of the code block `at` is in, else -1; `at` only moves forward
  const codeEnd = (at: number) => {
    while (inBlock < blocks.length && blocks[inBlock][1] <= at) inBlock++
    return inBlock < blocks.length && blocks[inBlock][0] <= at ? blocks[inBlock][1] : -1
  }

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
    let depth = 0
    let j = start.index
    for (;;) {
      DETAILS_TAG.lastIndex = j
      const tag = DETAILS_TAG.exec(text)
      if (!tag) {
        j = text.length
        break
      }
      const inCode = codeEnd(tag.index)
      if (inCode !== -1) {
        j = inCode
        continue
      }
      j = tag.index + tag[0].length
      depth += tag[0] === '<details>' ? 1 : -1
      if (depth === 0) break
    }

    // outer 영역 skip + 직후 trailing 공백·개행 skip (block 사이 \n\n
    // 가 chatStreamManager 에서 추가됨 — 답변 시작 전 공백 정리)
    i = j
    while (i < text.length && (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t')) {
      i++
    }
  }
}
