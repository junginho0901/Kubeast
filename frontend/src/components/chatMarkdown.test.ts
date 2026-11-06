import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '@/components/FloatingAIChat/MessageList'
import { MessageBubble } from '@/pages/ai-chat/MessageBubble'
import type { Message } from '@/pages/ai-chat/types'
import { ChatStreamManager } from '@/services/chatStreamManager'

// What a chat answer may draw, in AI Chat and the floating chat, saved and while it comes: the elements an answer uses
// stay, and nothing it writes can restyle the page, cover what is next to it or move it elsewhere.

const t = ((key: string) => key) as unknown as TFunction

function aiChat(content: string, extra: Partial<Message> = {}) {
  const message = { role: 'assistant', content, ...extra } as Message
  return renderToStaticMarkup(createElement(MessageBubble, { message, idx: 0, copiedMessageKey: null, onCopy: () => {}, onDownloadJson: () => {}, t }))
}

const floating = (content: string, toolCalls?: unknown[]) =>
  renderToStaticMarkup(createElement(MessageList, { messages: [{ id: 1, role: 'assistant', content, toolCalls }] }))

const SURFACES: [string, (md: string, toolCalls?: unknown[]) => string][] = [
  ['AI Chat, saved', (md, toolCalls) => aiChat(md, { toolCalls } as Partial<Message>)],
  ['AI Chat, while it comes', (md, toolCalls) => aiChat(md, { toolCalls, isTemporary: true, streamingPhase: 'answer' } as Partial<Message>)],
  ['floating chat, saved', floating],
  ['floating chat, while it comes', (md, toolCalls) =>
    renderToStaticMarkup(createElement(MessageList, { messages: [], streaming: true, streamingContent: md, streamingToolCalls: toolCalls }))],
]

// every element the answer drew: text is escaped in static markup, so each "<name" is a real element. Left out are the
// preload React adds for the avatar and the Copy controls under the answer.
const elements = (html: string) =>
  [...html
    .replace(/<link rel="preload" as="image" href="\/icon\.svg"[^>]*>/g, '')
    .split(/<[a-z]+\b[^>]*data-testid="(?:message-actions-row|floating-copy)"/)[0]
    .matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase())
const anchor = (html: string, href: string) => new RegExp(`<a\\b[^>]*href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(html)?.[0] ?? 'no such link'

describe.each(SURFACES)('%s: what an answer cannot draw', (_name, render) => {
  it.each([
    ['style', '<style>[data-testid="tool-approval-card"]{display:none}</style>'],
    ['meta', '<meta http-equiv="refresh" content="0;url=https://example.test/">'],
    ['link', '<link rel="stylesheet" href="https://example.test/a.css">'],
    ['base', '<base href="https://example.test/">'],
    ['title', '<title>Another page</title>'],
    ['iframe', '<iframe src="https://example.test/"></iframe>'],
    ['form', '<form action="https://example.test/"><p>text</p></form>'],
    ['button', '<button>text</button>'],
    ['textarea', '<textarea>text</textarea>'],
    ['select', '<select><option>text</option></select>'],
    ['object', '<object data="https://example.test/"></object>'],
    ['embed', '<embed src="https://example.test/">'],
    ['video', '<video src="https://example.test/" autoplay></video>'],
    ['audio', '<audio src="https://example.test/" autoplay></audio>'],
    ['dialog', '<dialog open>text</dialog>'],
    ['svg', '<svg width="9999" height="9999"><rect width="9999" height="9999"/></svg>'],
    ['marquee', '<marquee>text</marquee>'],
    ['script', '<script>globalThis.x = 1</script>'],
  ])('<%s>', (tag, raw) => {
    const html = render(`Before.\n\n${raw}\n\nAfter.`)
    expect(elements(html)).not.toContain(tag)
    expect(html).toContain('After.')
  })

  it.each([
    ['style', '<style>x{}'],
    ['textarea', '<textarea>x'],
    ['title', '<title>x'],
    ['xmp', '<xmp>x'],
    ['iframe', '<iframe>x'],
    ['noembed', '<noembed>x'],
    ['noframes', '<noframes>x'],
    ['plaintext', '<plaintext>x'],
    ['script', '<script>x'],
  ])('<%s> left open hides nothing after it', (tag, raw) => {
    const html = render(`${raw}\n\nAfter.\n\n<details>\n<summary>🔧 <strong>tool</strong></summary>\n\nbody\n\n</details>`)
    expect(elements(html)).not.toContain(tag)
    expect(html).toContain('After.')
    expect(html).toContain('🔧 <strong>tool</strong>')
    expect(html).toContain('md-summary')
  })

  it('takes a style, a class and the attributes that act on the page off any element', () => {
    const raw = '<div style="position:fixed;inset:0;z-index:9999" class="fixed inset-0 z-50" id="approve" hidden popover tabindex="1" accesskey="a" contenteditable="true" dir="rtl" data-testid="tool-approval-card" onclick="x()">kept</div>'
    expect(render(raw)).toContain('<div>kept</div>')
    const inline = render('Some <span style="position:fixed" class="fixed">kept</span> words.')
    expect(inline).toContain('Some <span>kept</span> words.')
  })

  it('takes everything but the address and title off a link and opens it in a new tab', () => {
    const html = render('<a href="https://example.test/docs" title="Docs" style="position:fixed;inset:0" class="fixed inset-0 z-50" target="_self" rel="opener" ping="https://example.test/p" download="x">docs</a>')
    const link = anchor(html, 'https://example.test/docs')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
    expect(link).toContain('title="Docs"')
    expect(link).not.toMatch(/style=|fixed|inset-0|z-50|ping=|download=|"opener"/)
  })

  it('opens a link written in markdown in a new tab too', () => {
    const link = anchor(render('[docs](https://example.test/docs)'), 'https://example.test/docs')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
  })

  it('a link left open does not take in the blocks after it', () => {
    const html = render('<a href="https://example.test/">docs\n\nNext paragraph.\n\n<details>\n<summary>🔧 <strong>tool</strong></summary>\n\nbody\n\n</details>\n\nLast paragraph.')
    expect(html).toContain('Next paragraph.')
    expect(html).toContain('md-summary')
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*(?:Next paragraph|md-summary|Last paragraph)/)
  })

  it('does not link to a script or a data address', () => {
    const html = render('<a href="javascript:alert(1)">one</a> <a href="data:text/html,x">two</a> <a href="vbscript:x">three</a>')
    expect(html).not.toMatch(/href="(?:javascript|data|vbscript):/)
    expect(html).toContain('one')
  })

  it('a task list box cannot become another kind of input', () => {
    const html = render('<input type="text" name="password" value="x" formaction="https://example.test/" autofocus>')
    expect(html).not.toMatch(/type="text"|name="password"|formaction|autofocus|value="x"/)
  })
})

describe.each(SURFACES)('%s: what an answer keeps', (_name, render) => {
  // a tool block as the server writes it (ai-service streaming.tool_block_markdown, access.section)
  const TOOL_BLOCK = [
    '<details>',
    '<summary>🔧 <strong>k8s_get_resources</strong></summary>',
    '',
    '<p><strong>🔐 Ran as:</strong> <code>dev@example.com</code> · role Read · whole cluster · read-only</p>',
    '',
    '<details>',
    '<summary><strong>🧾 Cluster requests (1)</strong></summary>',
    '',
    '<ul>',
    '<li>list pods in shop → 200 · Audit-ID <code>kubeast-1</code> ✓</li>',
    '</ul>',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><strong>📋 Arguments</strong></summary>',
    '',
    '```json',
    '{\n  "namespace": "shop"\n}',
    '```',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><strong>📊 Results</strong></summary>',
    '',
    '```yaml',
    'name: web-1',
    '```',
    '',
    '</details>',
    '',
    '</details>',
    '',
    'There is one pod.',
  ].join('\n')

  it('a tool block stays the closed disclosure with all its parts', () => {
    const html = render(TOOL_BLOCK)
    expect(html.match(/class="md-details"/g)).toHaveLength(4)
    expect(html.match(/<button type="button" class="md-summary" aria-expanded="false">/g)).toHaveLength(4)
    expect(html.match(/data-testid="md-details-body"/g)).toHaveLength(4)
    expect(html).toContain('🔧 <strong>k8s_get_resources</strong>')
    expect(html).toContain('<strong>📋 Arguments</strong>')
    expect(html).toContain('<strong>📊 Results</strong>')
    expect(html).toContain('<p><strong>🔐 Ran as:</strong> <code>dev@example.com</code> · role Read · whole cluster · read-only</p>')
    expect(html).toContain('<li>list pods in shop → 200 · Audit-ID <code>kubeast-1</code> ✓</li>')
    expect(html).toContain('<code class="language-json">{\n  &quot;namespace&quot;: &quot;shop&quot;\n}\n</code>')
    expect(html).toContain('<code class="language-yaml">name: web-1\n</code>')
    expect(html).toContain('There is one pod.')
  })

  it('a block marked open starts open', () => {
    expect(render('<details open>\n<summary>More</summary>\n\nbody\n\n</details>')).toContain('aria-expanded="true"')
  })

  it('a table goes in its box with its columns aligned', () => {
    const html = render('| Name | Count |\n|:---|---:|\n| web | 3 |')
    expect(html).toContain('data-testid="chat-table"')
    expect(html).toContain('<th style="text-align:left">Name</th>')
    expect(html).toContain('<td style="text-align:right">3</td>')
    const written = render('<table><thead><tr><th colspan="2" scope="col">Name</th></tr></thead><tbody><tr><td rowspan="2" align="center">web</td></tr></tbody></table>')
    expect(written).toContain('data-testid="chat-table"')
    expect(written).toContain('<th colSpan="2" scope="col">Name</th>')
    expect(written).toContain('<td rowSpan="2" style="text-align:center">web</td>')
  })

  it('code blocks and inline code', () => {
    const html = render('Run `kubectl get pods`.\n\n```bash\nkubectl get pods\n```')
    expect(html).toContain('<code>kubectl get pods</code>')
    expect(html).toContain('<pre><code class="language-bash">kubectl get pods\n</code></pre>')
  })

  it('task lists, numbered lists from their first number, and footnotes that find each other', () => {
    const tasks = render('- [x] done\n- [ ] todo')
    expect(tasks).toContain('<ul class="contains-task-list">')
    expect(tasks).toContain('<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>')
    expect(render('3. third\n4. fourth')).toContain('<ol start="3">')
    const notes = render('Word[^1] here.\n\n[^1]: The note.')
    expect(notes).toContain('id="user-content-fn-1"')
    expect(notes).toContain('id="user-content-fnref-1"')
    expect(notes).toContain('id="footnote-label"')
    const toNote = anchor(notes, '#user-content-fn-1')
    expect(toNote).toContain('aria-describedby="footnote-label"')
    expect(toNote).not.toContain('target=')
    expect(anchor(notes, '#user-content-fnref-1')).not.toContain('target=')
  })

  it('the plain elements a model writes', () => {
    const html = render('A<br>B <sub>c</sub> <sup>d</sup> <kbd>e</kbd> <mark>f</mark> <b>g</b> <i>h</i> <u>i</u> <s>j</s> <small>k</small> <abbr title="Long name">l</abbr> <del>m</del> <em>n</em>')
    expect(html).toMatch(/A<br\/?>/)
    for (const part of ['<sub>c</sub>', '<sup>d</sup>', '<kbd>e</kbd>', '<mark>f</mark>', '<b>g</b>', '<i>h</i>', '<u>i</u>', '<s>j</s>', '<small>k</small>', '<abbr title="Long name">l</abbr>', '<del>m</del>', '<em>n</em>']) {
      expect(html).toContain(part)
    }
  })

  it('an image keeps its address and its text', () => {
    expect(render('![A chart](https://example.test/a.png "Title")')).toContain('<img src="https://example.test/a.png" alt="A chart" title="Title"/>')
  })

  it('a link to a resource opens its drawer, and a malformed one is plain text', () => {
    const link = anchor(render('[nginx](kubest://pod?ns=default&name=nginx-abc)'), 'kubest://pod?ns=default&amp;name=nginx-abc')
    expect(link).toContain('class="text-primary-400 underline decoration-dotted hover:text-primary-300"')
    expect(link).not.toContain('target=')
    const bad = render('[bad](kubest://pod?ns=../etc&name=x)')
    expect(bad).toContain('<span class="text-slate-400">bad</span>')
  })

  it('the graphs the AI asked to show go under the answer', () => {
    const chart = { title: 'CPU', unit: 'cores', promql: 'up', series: [{ label: 'a', points: [[1, 1], [2, 2]] }] }
    const html = render('Answer.', [{ function: 'prometheus_query', chart }])
    expect(html).toContain('data-testid="chat-charts"')
    expect(html).toContain('CPU')
  })
})

describe('the rest of the answer row', () => {
  it('AI Chat keeps its action row and Copy on a finished answer', () => {
    const html = aiChat('<b>Answer</b>')
    expect(html).toContain('data-testid="message-actions"')
    expect(html).toContain('aiChat.copyMessage')
  })

  it('the floating chat keeps its copy control on a finished answer', () => {
    expect(floating('<b>Answer</b>')).toContain('data-testid="floating-copy"')
  })

  it('the approval card stays whole, below the answer and outside it, whatever the answer holds', () => {
    const answer = [
      '<style>[data-testid="tool-approval-card"] pre{visibility:hidden}</style>',
      '<div style="position:fixed;inset:0;z-index:9999;background:#000"></div>',
      '<a href="https://example.test/" style="position:fixed;inset:0;z-index:9999;display:block" class="fixed inset-0 z-50">Continue</a>',
    ].join('\n\n')
    const html = aiChat(answer, { toolCalls: [{ approval_id: 'ap1', function: 'k8s_scale', args: { replicas: 2 }, cluster: 'self', approval_status: 'pending' }] } as Partial<Message>)
    const card = html.indexOf('data-testid="tool-approval-card"')
    expect(card).toBeGreaterThan(-1)
    expect(html.indexOf('Continue')).toBeLessThan(card)
    expect(html.slice(card)).toContain('k8s_scale')
    expect(html.slice(card)).toContain('&quot;replicas&quot;: 2')
    expect(html).not.toMatch(/position:fixed|z-index:9999|inset-0 z-50/)
    expect(elements(html)).not.toContain('style')
  })
})

describe.each(SURFACES)('%s: a tool result with lines of backticks', (_name, render) => {
  const RESULT = ['line 1', '```', '<style>x{}</style>', '<meta http-equiv="refresh" content="0;url=https://example.test/">', '<div id="outside">outside</div>', '```', 'line 2'].join('\n')

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function liveAnswer(result: string) {
    const body = [{ function: 'k8s_pod_logs', args: {}, call_id: 0 }, { function_result: 'k8s_pod_logs', result, call_id: 0 }, { content: 'Done.' }, '[DONE]']
      .map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }))))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'logs?')
    await vi.runAllTimersAsync()
    return manager.getState().content
  }

  function expectInItsBlock(html: string) {
    expect(elements(html)).not.toContain('style')
    expect(elements(html)).not.toContain('meta')
    expect(html).not.toContain('<div id="outside">')
    expect(html).not.toContain('<div>outside</div>')
    const escaped = 'line 1\n```\n&lt;style&gt;x{}&lt;/style&gt;\n&lt;meta http-equiv=&quot;refresh&quot; content=&quot;0;url=https://example.test/&quot;&gt;\n&lt;div id=&quot;outside&quot;&gt;outside&lt;/div&gt;\n```\nline 2\n'
    expect(html).toContain(`<pre><code>${escaped}</code></pre>`)
    expect(html).toContain('Done.')
  }

  it('stays in its code block while the answer comes', async () => {
    expectInItsBlock(render(await liveAnswer(RESULT)))
  })

  it('what falls out of the short block of an answer saved earlier draws only what any answer may', () => {
    const earlier = `<details>\n<summary><strong>📊 Results</strong></summary>\n\n\`\`\`\n${RESULT}\n\`\`\`\n\n</details>\n\nDone.`
    const html = render(earlier)
    expect(elements(html)).not.toContain('style')
    expect(elements(html)).not.toContain('meta')
    expect(html).not.toContain('id="outside"')
    expect(html).toContain('Done.')
  })

  // the saved answer as ai-service tests/test_tool_result_fence.py expects it to be written
  it('stays in its code block in a saved answer', () => {
    const saved = `<details>\n<summary>🔧 <strong>k8s_pod_logs</strong></summary>\n\n<p><strong>📋 Arguments:</strong> No arguments</p>\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n\`\`\`\`\n${RESULT}\n\`\`\`\`\n\n</details>\n\n</details>\n\nDone.`
    expectInItsBlock(render(saved))
  })
})
