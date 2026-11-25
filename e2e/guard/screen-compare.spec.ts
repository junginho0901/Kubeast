import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { comparePictures, compileIntended, FAINT_DELTA, FAINT_PIXELS, intendedWithin, TOLERANCE, type IntendedRule } from './screen-compare'
import { DRAWER, DRAWER_KINDS, SIDEBAR } from './shared'

// The picture comparison on its own, with pictures drawn in the browser: no cluster.

async function picture(page: Page, draw: string): Promise<Buffer> {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#101010">${draw}</body></html>`)
  return page.screenshot()
}
const square = (colour: string, left = 10) => `<div style="position:absolute;left:${left}px;top:20px;width:30px;height:10px;background:${colour}"></div>`
const grey = (n: number) => `rgb(${n},${n},${n})`

test.describe('the picture comparison', () => {
  test.use({ viewport: { width: 100, height: 60 }, storageState: { cookies: [], origins: [] } })

  test('the same picture has no differing pixels', async ({ page }) => {
    const a = await picture(page, square('#fff'))
    expect(await comparePictures(page, a, a)).toMatchObject({ pixels: 0, box: null, marked: null })
  })

  test('a moved shape is found by value, with where it is and a marked picture', async ({ page }) => {
    const a = await picture(page, square('#fff'))
    const b = await picture(page, square('#fff', 20))
    const out = await comparePictures(page, a, b)
    expect(out.pixels).toBe(10 * 10 * 2) // the left strip it left and the right strip it took
    expect(out.box).toEqual({ x: 10, y: 20, width: 40, height: 10 })
    expect(out.size).toBe('100x60')
    expect(out.marked?.subarray(1, 4).toString(), 'the marked picture is a PNG').toBe('PNG')
  })

  test('one pixel is enough', async ({ page }) => {
    const a = await picture(page, '')
    const b = await picture(page, '<div style="position:absolute;left:5px;top:5px;width:1px;height:1px;background:#fff"></div>')
    expect(await comparePictures(page, a, b)).toMatchObject({ pixels: 1, box: { x: 5, y: 5, width: 1, height: 1 } })
  })

  test('a colour change past the tolerance counts and one within it does not', async ({ page }) => {
    const base = await picture(page, square(grey(100)))
    const within = await picture(page, square(grey(100 + TOLERANCE)))
    const past = await picture(page, square(grey(100 + TOLERANCE + 1)))
    expect((await comparePictures(page, base, within)).pixels).toBe(0)
    expect((await comparePictures(page, base, past)).pixels).toBe(30 * 10)
  })

  test('a few faint pixels are a redraw; more of them, or one strong one, are a difference', async ({ page }) => {
    const spot = (colour: string, width: number) => `<div style="position:absolute;left:5px;top:5px;width:${width}px;height:1px;background:${colour}"></div>`
    const base = await picture(page, spot(grey(100), FAINT_PIXELS + 1))
    const faint = (width: number) => picture(page, spot(grey(100), FAINT_PIXELS + 1) + spot(grey(100 + FAINT_DELTA), width))
    expect((await comparePictures(page, base, await faint(FAINT_PIXELS))).pixels, 'as many as a redraw moves').toBe(0)
    expect((await comparePictures(page, base, await faint(FAINT_PIXELS + 1))).pixels, 'one more').toBe(FAINT_PIXELS + 1)
    const strong = await picture(page, spot(grey(100), FAINT_PIXELS + 1) + spot(grey(100 + FAINT_DELTA + 1), 1))
    expect((await comparePictures(page, base, strong)).pixels, 'one pixel moved further').toBe(1)
  })

  test('pictures of two sizes differ where only one has pixels', async ({ page }) => {
    const small = await picture(page, '')
    await page.setViewportSize({ width: 100, height: 70 })
    const tall = await picture(page, '')
    const out = await comparePictures(page, small, tall)
    expect(out.pixels).toBe(100 * 10)
    expect(out.size).toBe('100x60 / 100x70')
  })

  test('an intended change names its screens; one with no reason or PR is refused', () => {
    const match = compileIntended([{ screen: '/workloads/pods', why: 'because', pr: '#1' }])
    expect(match('default · /workloads/pods on self')?.pr).toBe('#1')
    expect(match('default · /cluster/nodes on self')).toBeNull()
    expect(() => compileIntended([{ screen: 'x', why: '', pr: '#1' }])).toThrow(/reason and a PR/)
    expect(() => compileIntended([{ screen: 'x', why: 'y', pr: '' }])).toThrow(/reason and a PR/)
  })

  test('an intended change kept to an element covers it and takes no screen; one that names no element is refused', () => {
    const rule: IntendedRule = { screen: '/workloads/pods on self$', within: 'nav svg', why: 'because', pr: '#1' }
    const list = [rule, { screen: '/alerts', why: 'because', pr: '#2' }]
    expect(intendedWithin(list)('default · /workloads/pods on self')).toEqual(['nav svg'])
    expect(intendedWithin(list)('default · /workloads/pods on test2'), 'another screen').toEqual([])
    expect(intendedWithin(list)('default · /alerts on self'), 'a rule that takes the whole screen covers no element').toEqual([])
    expect(compileIntended(list)('default · /workloads/pods on self'), 'the rest of the screen is compared').toBeNull()
    expect(compileIntended(list)('default · /alerts on self')?.pr).toBe('#2')
    expect(intendedWithin([rule, { ...rule, within: 'h1' }])('default · /workloads/pods on self'), 'each rule of a screen').toEqual(['nav svg', 'h1'])
    expect(() => compileIntended([{ ...rule, within: ' ' }])).toThrow(/no element to keep to/)
    expect(() => intendedWithin([{ ...rule, within: '' }])).toThrow(/no element to keep to/)
    expect(() => intendedWithin([{ ...rule, pr: '' }])).toThrow(/reason and a PR/)
  })

  // Every name screen-diff.spec.ts gives a screen of the sidebar, and the drawers as it names them.
  const modes = ['default', 'dark', 'light']
  const names = [
    ...modes.flatMap((mode) => [...new Set(SIDEBAR), '/account'].map((p) => `${mode} · ${p} on self`)),
    ...['default', 'test2'].flatMap((cluster) => [...new Set(SIDEBAR)].map((p) => `default · ${p} on ${cluster}`)),
    ...modes.flatMap((mode) => DRAWER_KINDS.map((kind) => `${mode} · drawer ${kind} (namespace under test)`)),
  ]
  const onEachCluster = (paths: string[]) => paths.flatMap((p) => [...modes.map((mode) => `${mode} · ${p} on self`), `default · ${p} on default`, `default · ${p} on test2`])
  const intendedList = () => (JSON.parse(fs.readFileSync(path.join(__dirname, 'screen-diff-intended.json'), 'utf8')) as { rules: IntendedRule[] }).rules

  test('the intended list takes the whole of nine screens, the Resource Graph and Alerts where they changed, and no other', () => {
    const match = compileIntended(intendedList())
    const of = (pr: string) => names.filter((name) => match(name)?.pr === pr).sort()
    expect(of('#1077')).toEqual(onEachCluster(['/cluster/resource-graph']).sort())
    expect(of('#1087')).toEqual([...modes.map((mode) => `${mode} · /alerts on self`), 'default · /alerts on default'].sort())
    expect(names.filter((name) => match(name)).length, 'screens taken whole').toBe(9)
    expect(match('default · /alerts on test2'), 'its names fit two lines').toBeNull()
  })

  test('the intended list covers one icon on the Gateway lists, the Workloads lists and the CronJob drawer, and nothing on the others', () => {
    const covered = intendedWithin(intendedList())
    const gateway = ['backendtlspolicies', 'gatewayclasses', 'gateways', 'grpcroutes', 'httproutes', 'policies', 'referencegrants'].map((k) => `/gateway/${k}`)
    const workloads = ['cronjobs', 'daemonsets', 'deployments', 'hpas', 'jobs', 'pdbs', 'pods', 'replicasets', 'statefulsets', 'vpas'].map((k) => `/workloads/${k}`)
    const inSidebar = (href: string) => [`[data-testid="sidebar-nav"] a[href="${href}"] > svg`]
    for (const name of onEachCluster(gateway)) expect(covered(name), name).toEqual(inSidebar('/gateway/httproutes'))
    for (const name of onEachCluster(workloads)) expect(covered(name), name).toEqual(inSidebar('/workloads/cronjobs'))
    const drawers = modes.map((mode) => `${mode} · drawer CronJob (namespace under test)`)
    for (const name of drawers) expect(covered(name).map((s) => s.startsWith(DRAWER) && s.endsWith('> svg')), name).toEqual([true])
    expect(names.filter((name) => covered(name).length > 0).sort()).toEqual([...onEachCluster([...gateway, ...workloads]), ...drawers].sort())
  })
})
