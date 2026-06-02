// Tool 호출 결과 (📊 Results) 가 너무 길면 표시할 때만 잘라서 보여준다.
// 다른 code block 은 건드리지 않음 — Results 블록만 잘라 화면 부담을 줄인다.
// DB / clipboard 에 들어가는 원본은 그대로.

const TOOL_RESULT_DISPLAY_MAX_CHARS = 2000
const TRUNCATED_MARKER = '... (truncated) ...'

export function truncateToolResultsInContent(content: string, maxChars = TOOL_RESULT_DISPLAY_MAX_CHARS) {
  if (!content) return content

  const resultsBlockRegex =
    /(<summary><strong>📊 Results<\/strong><\/summary>[\s\S]*?```(?:json|yaml)?\r?\n)([\s\S]*?)(\r?\n```)/g

  return content.replace(resultsBlockRegex, (_match, prefix: string, body: string, suffix: string) => {
    if (body.includes(TRUNCATED_MARKER)) return `${prefix}${body}${suffix}`
    if (body.length <= maxChars) return `${prefix}${body}${suffix}`
    const truncatedBody = body.slice(0, maxChars) + `\n${TRUNCATED_MARKER}`
    return `${prefix}${truncatedBody}${suffix}`
  })
}
