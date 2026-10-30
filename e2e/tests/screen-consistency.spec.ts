import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// Every screen the sidebar lists (the admin ones too) and the account page, in each colour mode:
// - a header row (.page-head) whose title and buttons do not fit sends the buttons to the next line instead of pushing
//   the page sideways (MutatingWebhookConfigurations at 1 070 px slid the title under the sidebar);
// - the buttons placed in a header row are btn-primary, and buttons with words on them look the same for one job
//   (a grey Create on the kinds a controller makes, four looks for Delete, three for CSV);
// - text is readable: axe-core's color-contrast rule (WCAG 2.2 SC 1.4.3, 4.5:1 or 3:1 for large text), on the screens
//   and on a stored AI answer with its tool boxes open (prose-invert was white on the light mode's off-white).

const MODES = ['default', 'dark', 'light'] as const
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }

async function screens(page: Page) {
  await page.goto('/?cluster=self')
  const nav = page.getByTestId('sidebar-nav')
  await expect(nav.locator('a[href^="/"]').first()).toBeAttached()
  const paths = [...new Set(await nav.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')))]
  expect(paths.length, 'the sidebar lists every screen').toBeGreaterThan(70)
  return [...paths, '/account']
}

async function setMode(page: Page, mode: string) {
  await page.evaluate((m) => (m === 'default' ? localStorage.removeItem('kubeast.colorMode') : localStorage.setItem('kubeast.colorMode', m)), mode)
}

async function open(page: Page, path: string, mode: string) {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}cluster=self`)
  await expect(page.locator('main h1').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.colorMode ?? 'default')).toBe(mode)
}

// texts below the contrast WCAG asks for, as "where: text (fg on bg, ratio)"
async function lowContrast(page: Page, where: string, include?: string) {
  const builder = new AxeBuilder({ page }).withRules(['color-contrast'])
  const result = await (include ? builder.include(include) : builder).analyze()
  return result.violations.flatMap((v) => v.nodes.map((n) => {
    const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number }
    return `${where}: ${n.target.join(' ')} (${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1)`
  }))
}

// the job of a button with words on it, from the words (English or Korean)
const JOBS: [string, RegExp][] = [
  ['refresh', /^(Refresh|새로고침)$/],
  ['create', /^(Create|New|Add|Register)\b|(생성|추가|등록)$/],
  ['delete', /^(Delete|Remove|Uninstall)\b|삭제/],
  ['export', /^(CSV|JSON|Export CSV|CSV 내보내기)$/],
]

test.describe('every screen in every colour mode', () => {
  test('at 1070 px no screen slides sideways', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1070, height: 1000 })
    const slid: string[] = []
    for (const path of await screens(page)) {
      await open(page, path, 'default')
      await page.waitForTimeout(300)
      const r = await page.evaluate(() => {
        const h1 = document.querySelector('main h1')!
        const main = document.querySelector('main')!
        const row = h1.closest('.page-head') ?? h1.parentElement?.parentElement
        const controls = row ? [...row.querySelectorAll('button, a, input, select')].filter((e) => e.getBoundingClientRect().width > 0) : []
        return {
          pageOver: document.documentElement.scrollWidth - innerWidth,
          mainOver: main.scrollWidth - main.clientWidth,
          titleLeft: h1.getBoundingClientRect().left,
          titleOver: h1.scrollWidth - h1.clientWidth, // the title's longest word past its block, under the buttons
          controlsRight: controls.reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0),
        }
      })
      if (r.pageOver > 1 || r.mainOver > 1 || r.titleLeft < 256 || r.titleOver > 1 || r.controlsRight > 1071) {
        slid.push(`${path}: page +${r.pageOver}, main +${r.mainOver}, title at ${Math.round(r.titleLeft)} +${r.titleOver}, buttons end ${Math.round(r.controlsRight)}`)
      }
    }
    expect(slid).toEqual([])
  })

  for (const mode of MODES) {
    test(`${mode}: header buttons are btn-primary, buttons of one job look alike, text is readable`, async ({ page }) => {
      test.setTimeout(600_000)
      await page.setViewportSize({ width: 1440, height: 900 })
      const paths = await screens(page)
      await setMode(page, mode)
      const notPrimary: string[] = []
      const headerLooks = new Map<string, string>()
      const jobLooks = new Map<string, Map<string, string>>()
      const unreadable: string[] = []
      for (const path of paths) {
        await open(page, path, mode)
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
        // the buttons placed in the header row itself; a dropdown's or a tab group's buttons sit one level down
        const header = await page.evaluate(() => {
          const head = document.querySelector('main h1')!.closest('.page-head')
          const areas = head ? [...head.children].slice(1) : []
          return areas
            .flatMap((a) => (a.matches('button, a.btn') ? [a] : [...a.children].filter((e) => e.matches('button, a.btn'))))
            .map((b) => ({ text: (b.textContent ?? '').trim().slice(0, 30), primary: b.classList.contains('btn-primary'), look: `${getComputedStyle(b).backgroundColor} / ${getComputedStyle(b).color}` }))
        })
        for (const b of header) {
          if (!b.primary) notPrimary.push(`${path} "${b.text}"`)
          headerLooks.set(b.look, `${path} "${b.text}"`)
        }
        const worded = await page.locator('main button').evaluateAll((bs) => bs
          .filter((b) => b.getBoundingClientRect().width > 0 && (b.textContent ?? '').trim() !== '')
          .map((b) => {
            const s = getComputedStyle(b)
            return { text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(), look: `${s.backgroundColor} | ${s.color} | ${s.borderTopColor} ${s.borderTopWidth} | ${s.borderTopLeftRadius} | ${Math.round(b.getBoundingClientRect().height)}px | ${s.fontSize}` }
          }))
        for (const b of worded) {
          const job = JOBS.find(([, re]) => re.test(b.text))?.[0]
          if (!job) continue
          if (!jobLooks.has(job)) jobLooks.set(job, new Map())
          jobLooks.get(job)!.set(b.look, `${path} "${b.text.slice(0, 30)}"`)
        }
        unreadable.push(...(await lowContrast(page, path)))
      }
      expect(notPrimary, 'header buttons that are not btn-primary').toEqual([])
      expect([...headerLooks.keys()], `header buttons by background / text: ${[...headerLooks.values()].join(', ')}`).toHaveLength(1)
      for (const [job, byLook] of jobLooks) {
        expect([...byLook.keys()], `${job} buttons look different: ${[...byLook.entries()].map(([l, w]) => `${w} = ${l}`).join(' · ')}`).toHaveLength(1)
      }
      expect(jobLooks.size, 'refresh, create, delete and export buttons were seen').toBe(4)
      expect(unreadable, 'texts below the contrast WCAG asks for').toEqual([])
    })

    test(`${mode}: an AI answer with its tool boxes open is readable`, async ({ page }) => {
      const title = `e2e-contrast-${mode}-${Date.now().toString(36)}`
      const answer = [
        '<details><summary>🔧 k8s_get_resources</summary>',
        '',
        '<p><strong>🔐 Ran as:</strong> <code>admin</code> · groups <code>kubeast:admin</code> · read-only</p>',
        '',
        '<details><summary><strong>🧾 Cluster requests (1)</strong></summary>',
        '',
        '<ul><li><code>GET /api/v1/namespaces/kube-system/pods</code> 200</li></ul>',
        '</details>',
        '',
        '<details><summary><strong>📋 Arguments</strong></summary>',
        '',
        '```json',
        '{"resource_type": "pods", "namespace": "kube-system"}',
        '```',
        '</details>',
        '',
        '<details><summary><strong>📊 Results</strong></summary>',
        '',
        '```',
        'NAME READY STATUS',
        'coredns-1 1/1 Running',
        '```',
        '</details>',
        '</details>',
        '',
        '### kube-system',
        '',
        'There are **2** pods, all `Running` and `1/1` Ready; see [the docs](https://kubernetes.io/docs/).',
        '',
        '| NAME | RESTARTS | AGE |',
        '| --- | --- | --- |',
        '| coredns-1 | **44** (5h ago) | 35d |',
        '| kube-proxy-1 | 1 | 35d |',
      ].join('\n')
      const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
      expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
      const sessionId = (await created.json()).id as string
      try {
        const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=self`, {
          headers: XRW,
          data: { messages: [{ role: 'user', content: 'pods in kube-system?' }, { role: 'assistant', content: answer }] },
        })
        expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
        await page.goto('/?cluster=self')
        await setMode(page, mode)
        await page.goto('/ai-chat?cluster=self')
        await page.getByText(title, { exact: true }).first().click()
        const bubble = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
        await expect(bubble.getByRole('button', { name: /k8s_get_resources/ })).toBeVisible()
        // open every tool box, the nested ones too: the first closed one each time (opening one changes the list)
        const closed = bubble.locator('.md-details:not([data-open]) > .md-summary')
        for (let i = 0; i < 10 && (await closed.count()) > 0; i++) await closed.first().click()
        await expect(closed).toHaveCount(0)
        await expect(bubble.getByText('NAME READY STATUS')).toBeVisible()
        await expect(bubble.locator('table th').first()).toHaveText('NAME')
        expect(await lowContrast(page, `${mode} answer`, 'main')).toEqual([])
      } finally {
        await page.request.delete(`/api/v1/sessions/${sessionId}?cluster=self`, { headers: XRW, failOnStatusCode: false })
      }
    })
  }
})
