import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { APIRequestContext, Page } from '@playwright/test'

// Raw recordings; scripts/site-media.sh keeps the marked parts of each and writes site/media/<name>.mp4 and .jpg.
const OUT = path.resolve(__dirname, '../test-results/clips')

/**
 * A clip of the page's video. Only the time between show() and hide() is kept, so page loads and waits
 * (an investigation, an upload) do not end up on the site.
 */
export function clip(page: Page, name: string) {
  // Times count from here. A script opens a page right after this and waits only with a page on screen: whether
  // the video starts at the page's creation or at its first frame, both are then this moment.
  const t0 = Date.now()
  const now = () => (Date.now() - t0) / 1000
  const parts: number[][] = []
  const steps: Array<[string, number]> = []
  // A time of the recording as a time of the kept clip: what is kept of the parts before it.
  const kept = (t: number) => parts.reduce((s, [from, to]) => s + Math.max(0, Math.min(to, t) - from), 0)
  return {
    show: () => { parts.push([now()]) },
    hide: () => { parts[parts.length - 1].push(now()) },
    /** The site's step list for this clip moves to `id` here (site/v2 lights it while the clip plays). */
    step: (id: string) => { steps.push([id, now()]) },
    async save() {
      const video = page.video()
      if (!video) throw new Error('video recording is off: run with --project=demo')
      const last = parts[parts.length - 1]
      if (last && last.length === 1) last.push(now())
      await page.close()
      fs.mkdirSync(OUT, { recursive: true })
      await video.saveAs(path.join(OUT, `${name}.webm`))
      fs.writeFileSync(path.join(OUT, `${name}.parts`), parts.map((p) => p.map((t) => t.toFixed(2)).join(' ')).join('\n') + '\n')
      const marks = Object.fromEntries(steps.map(([id, t]) => [id, Math.round(kept(t) * 10) / 10]))
      fs.writeFileSync(path.join(OUT, `${name}.steps.json`), JSON.stringify(marks) + '\n')
    },
  }
}

/** A pause long enough to read what just appeared. */
export const beat = (page: Page, ms = 1500) => page.waitForTimeout(ms)

/** Goes to a screen the way a person does: opens its sidebar group when closed, then clicks the item. */
export async function openNav(page: Page, group: string, item: string) {
  const nav = page.getByTestId('sidebar-nav')
  const link = nav.getByRole('link', { name: item, exact: true })
  // A closed group keeps its links in the DOM, folded to zero rows (Layout.tsx), so isVisible() says yes.
  if (await link.evaluate((a) => !!a.closest('[class*="grid-rows-[0fr]"]'))) {
    await nav.getByRole('button', { name: group, exact: true }).click()
  }
  await link.click()
}

/** kubectl against one of the dev kind clusters (kubeast, kubeast-b). */
export function kubectl(cluster: string, args: string[]): string {
  const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), 'kubeconfig')
  fs.writeFileSync(kc, execFileSync('kind', ['get', 'kubeconfig', '--name', cluster], { encoding: 'utf8' }), { mode: 0o600 })
  try {
    return execFileSync('kubectl', ['--kubeconfig', kc, ...args], { encoding: 'utf8' })
  } finally {
    fs.rmSync(path.dirname(kc), { recursive: true, force: true })
  }
}

export const XRW = { 'X-Requested-With': 'XMLHttpRequest' }

/**
 * A Member made for one clip (a clean chat list, a user who asks for access), removed by done(). `admin` is an
 * API context signed in as the admin (the project's storage state).
 */
export async function demoUser(admin: APIRequestContext, name: string, email: string, clusterRole: string) {
  const users = (await (await admin.get('/api/v1/auth/admin/users', { params: { limit: 500 } })).json()) as Array<{ id: string; email: string }>
  const leftover = users.find((u) => u.email === email)
  if (leftover) await admin.delete(`/api/v1/auth/admin/users/${leftover.id}`)
  const roles = await (await admin.get('/api/v1/auth/roles')).json()
  const member = (Array.isArray(roles) ? roles : roles.roles || roles.items).find((r: { name: string }) => r.name === 'Member')
  const password = randomBytes(12).toString('base64url')
  const created = await admin.post('/api/v1/auth/admin/users', { data: { name, email, password, role_id: member.id } })
  if (created.status() !== 201) throw new Error(`create ${email}: ${created.status()} ${await created.text()}`)
  const id = (await created.json()).id as string
  const granted = await admin.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { data: { role: clusterRole } })
  if (!granted.ok()) throw new Error(`grant ${clusterRole}: ${granted.status()}`)
  return {
    id,
    /** Signs this page in as the user, from a clean browser (no admin cookies or saved cluster). */
    async signIn(page: Page) {
      await page.context().clearCookies()
      await page.goto('/login')
      await page.evaluate(() => localStorage.clear())
      await page.reload()
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
    },
    done: async () => { await admin.delete(`/api/v1/auth/admin/users/${id}`) },
  }
}
