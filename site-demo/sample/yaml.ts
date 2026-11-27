// YAML for the demo's objects: written as kubectl writes it (block style, two spaces, a list's items under its key) and
// read back from the YAML window's text. The reader takes block maps and lists, plain, quoted and block scalars, and
// JSON-style flow collections; anything else is answered as kubectl would ("error converting YAML to JSON").

type Obj = Record<string, any>
const isMap = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// ---- Writing

const plain = (s: string) => s !== '' && !/^[\s\-?:,[\]{}#&*!|>'"%@`]|: |\s#|\s$|^(true|false|null|yes|no|on|off|~|[-+]?(\d[\d_]*\.?\d*|\.\d+)(e[-+]?\d+)?)$/i.test(s)
const scalar = (v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return '[]'
  if (isMap(v)) return '{}'
  if (typeof v === 'string') return plain(v) && !v.includes('\n') ? v : JSON.stringify(v)
  return String(v)
}

function entries(o: Obj, n: number, out: string[]) {
  const pad = ' '.repeat(n)
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue
    const key = pad + (plain(k) ? k : JSON.stringify(k)) + ':'
    if (isMap(v) && Object.keys(v).length) { out.push(key); entries(v, n + 2, out) }
    else if (Array.isArray(v) && v.length) { out.push(key); items(v, n, out) }
    else if (typeof v === 'string' && v.includes('\n') && !/\n\n$/.test(v) && !/^\s/.test(v)) {
      out.push(key + (v.endsWith('\n') ? ' |' : ' |-'))
      for (const line of v.replace(/\n$/, '').split('\n')) out.push(line ? pad + '  ' + line : '')
    } else out.push(key + ' ' + scalar(v))
  }
}

function items(a: unknown[], n: number, out: string[]) {
  const pad = ' '.repeat(n)
  for (const v of a) {
    if (isMap(v) && Object.keys(v).length) {
      const sub: string[] = []
      entries(v, n + 2, sub)
      out.push(pad + '- ' + sub[0].slice(n + 2), ...sub.slice(1))
    } else if (Array.isArray(v) && v.length) { out.push(pad + '-'); items(v, n + 2, out) }
    else out.push(pad + '- ' + scalar(v))
  }
}

export function toYaml(o: Obj): string {
  const out: string[] = []
  entries(o, 0, out)
  return out.join('\n') + '\n'
}

// ---- Reading

export function fromYaml(src: string): unknown {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const fail = (why: string): never => { throw new Error('error converting YAML to JSON: yaml: line ' + (i + 1) + ': ' + why) }
  const indent = (l: string) => l.length - l.trimStart().length
  const skip = () => { while (i < lines.length && /^\s*(#.*)?$|^---\s*$/.test(lines[i])) i++ }
  const dash = (l: string) => /^-(\s|$)/.test(l.trimStart())
  const keyLine = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[-][^#]*?|-[^\s][^#]*?)\s*:(?:\s+(.*))?$/

  function value(text: string): unknown {
    const t = text.trim()
    if (t.startsWith('"')) { try { return JSON.parse(t.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? '') } catch { return fail('found invalid quoted string') } }
    if (t.startsWith("'")) { const m = t.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : fail('found unterminated quoted string') }
    const bare = t.replace(/\s+#.*$/, '')
    if (bare.startsWith('{') || bare.startsWith('[')) {
      try { return JSON.parse(bare.replace(/([{,]\s*)([A-Za-z0-9_.\-/]+)\s*:/g, '$1"$2":')) } catch { return fail('did not find expected flow collection end') }
    }
    if (bare === '' || bare === '~' || bare === 'null') return null
    if (bare === 'true' || bare === 'false') return bare === 'true'
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(bare) && !/^0\d/.test(bare)) return Number(bare)
    return bare
  }

  function blockText(header: string, n: number): string {
    const body: string[] = []
    let at = -1
    while (i < lines.length && (lines[i].trim() === '' || indent(lines[i]) > n)) {
      if (lines[i].trim() !== '' && at < 0) at = indent(lines[i])
      body.push(lines[i])
      i++
    }
    while (body.length && body[body.length - 1].trim() === '') body.pop()
    const text = body.map((l) => l.slice(Math.max(at, 0))).join(header.startsWith('>') ? ' ' : '\n')
    return header.includes('-') ? text : text + '\n'
  }

  function node(n: number): unknown {
    skip()
    if (i >= lines.length || indent(lines[i]) < n) return null
    return dash(lines[i]) ? list(indent(lines[i])) : map(indent(lines[i]))
  }

  function list(n: number): unknown[] {
    const out: unknown[] = []
    for (skip(); i < lines.length && indent(lines[i]) === n && dash(lines[i]); skip()) {
      const rest = lines[i].trimStart().slice(1).trimStart()
      const col = lines[i].length - rest.length
      if (!rest) { i++; out.push(node(n + 1)); continue }
      if (keyLine.test(rest) && !/^["'[{]/.test(rest)) { lines[i] = ' '.repeat(col) + rest; out.push(map(col)); continue }
      i++
      out.push(/^[|>][-+]?$/.test(rest) ? blockText(rest, n) : value(rest))
    }
    return out
  }

  function map(n: number): Obj {
    const out: Obj = {}
    for (skip(); i < lines.length && indent(lines[i]) === n && !dash(lines[i]); skip()) {
      const m = keyLine.exec(lines[i].trim())
      if (!m) fail('could not find expected \':\'')
      const key = String(value(m![1]))
      const rest = (m![2] ?? '').trim()
      i++
      if (rest === '' || rest.startsWith('#')) {
        skip()
        const next = i < lines.length ? lines[i] : ''
        out[key] = i < lines.length && (indent(next) > n || (indent(next) === n && dash(next))) ? node(indent(next)) : null
      } else if (/^[|>][-+]?$/.test(rest)) out[key] = blockText(rest, n)
      else out[key] = value(rest)
    }
    skip()
    if (i < lines.length && indent(lines[i]) > n) fail('mapping values are not allowed in this context')
    return out
  }

  skip()
  if (i >= lines.length) return null
  const top = node(indent(lines[i]))
  skip()
  if (i < lines.length) fail('did not find expected key')
  return top
}
