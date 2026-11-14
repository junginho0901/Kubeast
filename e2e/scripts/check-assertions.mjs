#!/usr/bin/env node
// Every e2e test must assert what it is named for. A test with no assertion, or one that only checks that
// elements are on screen (toBeVisible / toBeAttached / toBeEnabled / a count above zero), passes while the
// behaviour behind it is broken. Fails when a test in e2e/tests or in an opt-in folder (e2e/fault, e2e/guard,
// e2e/actions) is either.
//
//   node e2e/scripts/check-assertions.mjs
//
// An outcome is any other matcher (toHaveText, toContainText, toBe, toEqual, toHaveTitle, toHaveClass,
// toHaveCount(0), expect.poll …) or a call to a function of the same file whose body asserts one.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// the default run, then the opt-in projects of playwright.config.ts (e2e/demo records clips and asserts nothing)
const DIRS = ['tests', 'fault', 'guard', 'actions']
const PRESENCE = /\.(toBeVisible|toBeAttached|toBeEnabled|toBeHidden|toBeDisabled)\(|toHaveCount\(\s*[1-9]|\.count\(\)\)\.toBeGreaterThan\(0\)/
const OUTCOME = /\.(toContainText|toHaveText|toBe|toEqual|toStrictEqual|toMatch|toHaveAttribute|toHaveValue|toHaveURL|toHaveTitle|toHaveClass|toBeChecked|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toContain|toBeTruthy|toBeFalsy|toBeNull|toHaveLength|toMatchObject|toHaveScreenshot|toHaveProperty|toBeCloseTo|toThrow)\(|expect\.poll|toHaveCount\(\s*0/
// a test named by a string, or by a variable (`for (const key of ORDER) test(key, …)`, the action suite)
const TEST = /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])(.+?)\1|^\s*test\(\s*([A-Za-z_$][\w$.]*)\s*,/gm
const HELPER = /^(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)^\}/gm

const problems = []
const specs = DIRS.flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)) : [])
  .filter((f) => f.endsWith('.spec.ts')).sort().map((f) => (d === 'tests' ? f : `${d}/${f}`)))
for (const file of specs) {
  const src = readFileSync(join(root, file.includes('/') ? file : `tests/${file}`), 'utf8')
  const asserting = [...src.matchAll(HELPER)].filter((m) => OUTCOME.test(m[2])).map((m) => m[1])
  const helperCall = asserting.length ? new RegExp(`\\b(${asserting.join('|')})\\(`) : null
  const starts = [...src.matchAll(TEST)]
  starts.forEach((m, i) => {
    const body = src.slice(m.index + m[0].length, i + 1 < starts.length ? starts[i + 1].index : src.length)
    const outcome = OUTCOME.test(body) || (helperCall && helperCall.test(body))
    const line = src.slice(0, m.index).split('\n').length
    if (!outcome && !PRESENCE.test(body) && !body.includes('expect')) problems.push(`${file}:${line} asserts nothing: ${m[2] ?? m[3]}`)
    else if (!outcome && PRESENCE.test(body)) problems.push(`${file}:${line} only checks presence: ${m[2] ?? m[3]}`)
  })
}
if (problems.length) {
  console.error(`${problems.length} e2e test(s) do not assert an outcome:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('every e2e test asserts an outcome')
