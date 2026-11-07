import { describe, expect, it } from 'vitest'
import { decodeSecretYaml, encodeSecretYaml, secretYamlToSave } from './utils'

const utf8 = (text: string) => new TextEncoder().encode(text)
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
const secretOf = (value: string) => `apiVersion: v1\ndata:\n    other: ${btoa('stays')}\n    value: ${value}\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n`
const savedOf = (window: string) => encodeSecretYaml(window)
const valueLineOf = (yaml: string) => yaml.split('\n').find((line) => line.startsWith('    value:')) ?? ''
const savedValueOf = (window: string) => valueLineOf(savedOf(window)).replace('    value:', '').trim()
const windowLine = (value: string) => `stringData:\n  value: ${value}\nkind: Secret\n`
const typed = (value: string) => encodeSecretYaml(windowLine(value)).split('\n')[1].replace('  value:', '').trim()
const typedBlock = (lines: string) => encodeSecretYaml(`stringData:\n  value: ${lines}\n  next: ${'n'}\nkind: Secret\n`)

// A save is a merge patch, which leaves what it does not name: a key whose line went from the window goes out as null.
describe('a key line deleted in the Secret YAML window', () => {
  const opened = 'apiVersion: v1\nstringData:\n  a: one\n  b: two\n  c: |\n    x\n    y: z\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\n'

  it('takes the key out of the object, the others saved as before', () => {
    const edited = opened.replace('  b: two\n', '')
    expect(secretYamlToSave(edited, opened)).toBe(`apiVersion: v1\ndata:\n  "b":\n  a: ${btoa('one')}\n  c: ${btoa('x\ny: z\n')}\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\n`)
  })

  it('takes a key with a block value out too', () => {
    const edited = opened.replace('  c: |\n    x\n    y: z\n', '')
    expect(secretYamlToSave(edited, opened)).toBe(`apiVersion: v1\ndata:\n  "c":\n  a: ${btoa('one')}\n  b: ${btoa('two')}\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\n`)
  })

  it('takes them all out when the whole section went', () => {
    const edited = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\n'
    expect(secretYamlToSave(edited, opened)).toBe(`${edited}data:\n  "a":\n  "b":\n  "c":\n`)
  })

  it('follows the indent of the section it writes into', () => {
    const wide = 'stringData:\n    a: one\n    b: two\nkind: Secret\n'
    expect(secretYamlToSave(wide.replace('    a: one\n', ''), wide)).toBe(`data:\n    "a":\n    b: ${btoa('two')}\nkind: Secret\n`)
  })

  it('takes out a mask whose line went, which is how the window says to remove a hidden value', () => {
    const masked = "stringData:\n  password: '***'\n  user: '***'\nkind: Secret\n"
    expect(secretYamlToSave(masked.replace("  user: '***'\n", ''), masked)).toBe(`data:\n  "user":\n  password: ${btoa('***')}\nkind: Secret\n`)
  })

  it('leaves a key that moved between the sections, was renamed in place or was kept', () => {
    expect(secretYamlToSave(opened, opened)).toBe(encodeSecretYaml(opened))
    const renamed = opened.replace('  a: one\n', '  z: one\n')
    expect(secretYamlToSave(renamed, opened)).toBe(encodeSecretYaml(renamed).replace('data:\n', 'data:\n  "a":\n'))
    const moved = "apiVersion: v1\ndata:\n  a: b25l\nstringData:\n  b: two\n  c: x\nkind: Secret\n"
    expect(secretYamlToSave(moved, opened)).toBe(encodeSecretYaml(moved))
  })

  it('leaves a key added since the window opened, which this person never saw', () => {
    // the server's object has a key the text does not name: only what was in the text at Edit can leave
    const before = 'stringData:\n  a: one\nkind: Secret\n'
    expect(secretYamlToSave('stringData:\n  a: changed\nkind: Secret\n', before)).toBe(`data:\n  a: ${btoa('changed')}\nkind: Secret\n`)
  })

  it('removes nothing from text it cannot read line by line', () => {
    const flow = 'data: {a: b25l}\nkind: Secret\n'
    expect(secretYamlToSave(flow, opened)).toBe(flow)
    expect(secretYamlToSave('', opened)).toBe('')
    expect(secretYamlToSave('# nothing here\n', opened)).toBe('# nothing here\n')
    expect(secretYamlToSave('kind: ConfigMap\n', opened)).toBe('kind: ConfigMap\n')
  })

  it('saves as before without the text the edit began from', () => {
    expect(secretYamlToSave(opened)).toBe(encodeSecretYaml(opened))
  })
})

// What the YAML window of a Secret does to the text the server sends: a caller who may edit reads data as stringData and
// saves it back as data. k8s-service's secret_apply_masks_test.go holds the server to the bytes pinned here.
describe('the Secret YAML window', () => {
  const masked = "apiVersion: v1\ndata:\n    password: '***'\n    user: '***'\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n"

  it('shows a masked value as the server sent it, under stringData', () => {
    expect(decodeSecretYaml(masked)).toBe("apiVersion: v1\nstringData:\n    password: '***'\n    user: '***'\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n")
  })

  it('saves a masked value as the base64 of the mask, which the server takes for the mask', () => {
    expect(encodeSecretYaml(decodeSecretYaml(masked))).toBe('apiVersion: v1\ndata:\n    password: Kioq\n    user: Kioq\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n')
    expect(atob('Kioq')).toBe('***')
  })

  it('takes the mask however a person writes it back', () => {
    for (const written of ["'***'", '"***"', '***', "'***' # kept"]) expect(typed(written)).toBe('Kioq')
  })

  it('round-trips a value the caller may read', () => {
    const shown = decodeSecretYaml(`apiVersion: v1\ndata:\n    password: ${btoa('fake-value')}\nkind: Secret\n`)
    expect(shown).toContain('password: fake-value')
    expect(encodeSecretYaml(shown)).toContain(`password: ${btoa('fake-value')}`)
  })

  describe('saves every value it shows byte for byte', () => {
    const texts: Record<string, string> = {
      'a plain word': 'fake-value',
      'words with spaces': 'fake value here',
      'spaces before and after': '  fake value  ',
      'a tab before and after': '\tfake\t',
      'a tab inside': 'fake\tvalue',
      'wrapped in single quotes': "'fake-value'",
      'wrapped in double quotes': '"fake-value"',
      'a single quote inside': "it's fake",
      'a double quote inside': 'say "fake"',
      'one quote at the start': "'fake",
      'Korean': '가짜비밀번호',
      'Korean with spaces around': ' 가짜 비밀번호 ',
      'Korean ending in the byte of a no-break space': '가짜애',
      'other scripts and an emoji': 'パスワード🔐ñ',
      'a hash': 'fake#value',
      'a hash after a space': 'fake #value',
      'a hash at the start': '#fake',
      'a colon': 'fake:value',
      'a colon and a space': 'key: value',
      'a colon at the end': 'fake:',
      'a URL': 'https://fake.example/a?b=c',
      'a line break': 'line one\nline two',
      'a final line break': 'fake-value\n',
      'only line breaks': '\n\n',
      'a carriage return': 'fake\r\nvalue\r',
      'a vertical tab and a form feed': '\vfake\f',
      'a delete character': 'fake\x7f',
      'a C1 control': 'fake\u0085value',
      'a line separator': 'fake\u2028value\u2029',
      'a byte order mark': '\ufefffake',
      'a no-break space at the ends': '\u00a0fake\u00a0',
      'an ideographic space at the ends': '\u3000fake\u3000',
      'a backslash': 'C:\\fake\\path',
      'the mask itself': '***',
      'the mask with its quotes': "'***'",
      'a placeholder': '<REDACTED:secret>',
      'the word null': 'null',
      'a tilde': '~',
      'true': 'true',
      'a number': '0123',
      'a float': '1.50',
      'a pipe': '|',
      'a pipe and a sign': '|-',
      'a greater-than': '>',
      'a dash': '-',
      'a list item': '- fake',
      'an open brace': '{fake',
      'an open bracket': '[fake',
      'an ampersand': '&fake',
      'a star': '*fake',
      'an exclamation mark': '!fake',
      'a binary tag': '!!binary ZmFrZQ==',
      'a percent': '%fake',
      'an at sign': '@fake',
      'a backtick': '`fake`',
      'a question mark': '? fake',
      'base64 of nothing to do with it': 'ZmFrZS12YWx1ZQ==',
      'YAML': 'a: 1\nb:\n  - c\n',
      'JSON': '{"a":"b"}',
    }
    for (const [title, text] of Object.entries(texts)) {
      it(title, () => {
        const sent = toBase64(utf8(text))
        expect(savedValueOf(decodeSecretYaml(secretOf(sent)))).toBe(sent)
      })
    }

    it('an empty value, which stays a value and is not taken for one to remove', () => {
      const shown = decodeSecretYaml(secretOf('""'))
      expect(valueLineOf(shown)).toBe('    value: ""')
      expect(savedValueOf(shown)).toBe('""')
    })

    const binaries: Record<string, number[]> = {
      'a NUL byte': [0x00, 0x66, 0x61, 0x6b, 0x65],
      'bytes that are not UTF-8': [0xff, 0xfe, 0xfd, 0xc0, 0xaf],
      'a cut UTF-8 character': [0x66, 0xe1, 0x84],
      'every byte value': Array.from({ length: 256 }, (_, i) => i),
    }
    for (const [title, bytes] of Object.entries(binaries)) {
      it(`binary: ${title}`, () => {
        const sent = toBase64(Uint8Array.from(bytes))
        const shown = decodeSecretYaml(secretOf(sent))
        expect(valueLineOf(shown)).toBe(`    value: !!binary ${sent}`)
        expect(savedValueOf(shown)).toBe(sent)
      })
    }

    it('random bytes, whatever they turn out to be', () => {
      let seed = 20261107
      const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
      for (let round = 0; round < 3000; round++) {
        const bytes = Uint8Array.from({ length: next() % 24 }, () => next() >> 16 & 0xff)
        const sent = bytes.length ? toBase64(bytes) : '""'
        expect(savedValueOf(decodeSecretYaml(secretOf(sent)))).toBe(sent)
      }
    })

    it('random text, in the shapes a value takes', () => {
      const pieces = ['a', ' ', '\t', '\n', ':', '#', "'", '"', '가', '\\', '-', '|', '>', '*', '!', '&', '{', '[', '%', '@', '`', '~', '\r', '🔐', '=', 'null']
      let seed = 7
      const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
      for (let round = 0; round < 3000; round++) {
        const text = Array.from({ length: next() % 8 }, () => pieces[(next() >> 16) % pieces.length]).join('')
        const sent = text ? toBase64(utf8(text)) : '""'
        expect(savedValueOf(decodeSecretYaml(secretOf(sent)))).toBe(sent)
      }
    })
  })

  describe('shows a value as itself', () => {
    it('Korean and other UTF-8 as their letters', () => {
      expect(valueLineOf(decodeSecretYaml(secretOf(toBase64(utf8('가짜비밀번호')))))).toBe('    value: 가짜비밀번호')
      expect(valueLineOf(decodeSecretYaml(secretOf(toBase64(utf8('파스워드🔐ñ')))))).toBe('    value: 파스워드🔐ñ')
    })

    it('a plain word as it always was', () => {
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa('fake value here'))))).toBe('    value: fake value here')
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa('null'))))).toBe('    value: null')
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa('0123'))))).toBe('    value: 0123')
    })

    it('what would read as something else in double quotes', () => {
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa('a: b'))))).toBe('    value: "a: b"')
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa('|'))))).toBe('    value: "|"')
      expect(valueLineOf(decodeSecretYaml(secretOf(btoa("'x'"))))).toBe(`    value: "'x'"`)
    })
  })

  describe('reads what a person writes as YAML reads it', () => {
    const value = (text: string) => toBase64(utf8(text))

    it('single quotes', () => {
      expect(typed("'abc'")).toBe(value('abc'))
      expect(typed("'it''s'")).toBe(value("it's"))
      expect(typed("''")).toBe('""')
    })

    it('double quotes, with YAML\'s escapes too', () => {
      expect(typed('"abc"')).toBe(value('abc'))
      expect(typed('"a\\tb\\n"')).toBe(value('a\tb\n'))
      expect(typed('"\\x41\\u00e9\\e"')).toBe(value('Aé\x1b'))
      expect(typed('""')).toBe('""')
    })

    it('a comment after the value', () => {
      expect(typed('abc # the note')).toBe(value('abc'))
      expect(typed("'abc' # the note")).toBe(value('abc'))
      expect(typed('"abc" # the note')).toBe(value('abc'))
    })

    it('a word that YAML would not take stays the word typed, instead of a value lost', () => {
      expect(typed('#abc')).toBe(value('#abc'))
      expect(typed('!Passw0rd')).toBe(value('!Passw0rd'))
      expect(typed('*abc')).toBe(value('*abc'))
      expect(typed('a: b')).toBe(value('a: b'))
      expect(typed("'open")).toBe(value("'open"))
      expect(typed('"open')).toBe(value('"open'))
      expect(typed('"bad \\q escape"')).toBe(value('"bad \\q escape"'))
    })

    it('Korean a person types, without an exception', () => {
      expect(typed('새비밀번호')).toBe(value('새비밀번호'))
    })

    it('a binary tag as the base64 it holds', () => {
      expect(typed('!!binary ZmFrZQ==')).toBe('ZmFrZQ==')
    })

    it('no value, which removes the key as the merge patch reads it', () => {
      expect(encodeSecretYaml('stringData:\n  value:\n  other: a\nkind: Secret\n')).toBe(`data:\n  value:\n  other: ${btoa('a')}\nkind: Secret\n`)
    })

    it('a literal block', () => {
      expect(typedBlock('|\n    one\n      two\n\n    three\n')).toBe(`data:\n  value: ${value('one\n  two\n\nthree\n')}\n  next: ${btoa('n')}\nkind: Secret\n`)
    })

    it('a literal block without or with its last line breaks', () => {
      expect(typedBlock('|-\n    one\n    two\n\n')).toBe(`data:\n  value: ${value('one\ntwo')}\n  next: ${btoa('n')}\nkind: Secret\n`)
      expect(typedBlock('|+\n    one\n')).toBe(`data:\n  value: ${value('one\n\n')}\n  next: ${btoa('n')}\nkind: Secret\n`)
    })

    it('a block whose indent is given', () => {
      expect(typedBlock('|2\n      one\n    two\n')).toBe(`data:\n  value: ${value('  one\ntwo\n')}\n  next: ${btoa('n')}\nkind: Secret\n`)
    })

    it('a folded block', () => {
      expect(typedBlock('>\n    one\n    two\n\n    three\n      deep\n    four\n')).toBe(`data:\n  value: ${value('one two\nthree\n  deep\nfour\n')}\n  next: ${btoa('n')}\nkind: Secret\n`)
      expect(typedBlock('>-\n    one\n    two\n')).toBe(`data:\n  value: ${value('one two')}\n  next: ${btoa('n')}\nkind: Secret\n`)
    })

    it('a block holding what looks like a key', () => {
      expect(typedBlock('|\n    host: fake\n    port: 1\n')).toBe(`data:\n  value: ${value('host: fake\nport: 1\n')}\n  next: ${btoa('n')}\nkind: Secret\n`)
    })

    it('a block at the end of the document', () => {
      expect(encodeSecretYaml('kind: Secret\nstringData:\n  value: |\n    one\n    two')).toBe(`kind: Secret\ndata:\n  value: ${value('one\ntwo')}`)
    })

    it('leaves the rest of the object alone', () => {
      const object = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  labels:\n    a: b\ntype: Opaque\n'
      expect(encodeSecretYaml(object)).toBe(object)
      expect(decodeSecretYaml(object)).toBe(object)
    })
  })
})
