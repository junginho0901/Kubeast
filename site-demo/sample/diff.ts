// A unified diff of two texts, as k8s-service makes one of a release's revisions: the two labels, then each hunk with three
// lines around its changes; "" when the texts are the same.

const CONTEXT = 3
const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

export function unifiedDiff(from: string, to: string, before: string, after: string): string {
  const a = linesOf(before), b = linesOf(after)
  let head = 0, tail = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const n = a.length - head - tail, m = b.length - head - tail
  if (!n && !m) return ''
  // common[i][j]: the longest common subsequence of what is left of both from i and j
  const common = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) common[i][j] = a[head + i] === b[head + j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1])
  const rows: Array<[string, string]> = a.slice(0, head).map((l) => [' ', l])
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[head + i] === b[head + j]) { rows.push([' ', a[head + i]]); i++; j++ }
    else if (i < n && (j === m || common[i + 1][j] >= common[i][j + 1])) rows.push(['-', a[head + i++]])
    else rows.push(['+', b[head + j++]])
  }
  rows.push(...a.slice(a.length - tail).map((l): [string, string] => [' ', l]))
  const out = ['--- ' + from, '+++ ' + to]
  const changed = rows.flatMap(([sign], i) => (sign === ' ' ? [] : [i]))
  for (let k = 0; k < changed.length;) {
    let last = k
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= CONTEXT * 2) last++
    const start = Math.max(0, changed[k] - CONTEXT), hunk = rows.slice(start, changed[last] + CONTEXT + 1)
    const side = (skip: string) => {
      const ahead = rows.slice(0, start).filter(([sign]) => sign !== skip).length, count = hunk.filter(([sign]) => sign !== skip).length
      return (count ? ahead + 1 : ahead) + ',' + count
    }
    out.push(`@@ -${side('+')} +${side('-')} @@`, ...hunk.map(([sign, line]) => sign + line))
    k = last + 1
  }
  return out.join('\n') + '\n'
}
