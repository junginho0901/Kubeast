import { test, expect, type APIRequestContext } from '@playwright/test'

// The browser tab icon set (frontend/public): what index.html and the manifest point at is served as that
// type and size, and the logo in the sidebar and on the sign-in page loads.

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

async function fetchOk(request: APIRequestContext, href: string) {
  const res = await request.get(href)
  expect(res.status(), href).toBe(200)
  return res
}

test.describe('Brand icon', () => {
  test('index.html links resolve to the icon files with their types', async ({ request }) => {
    const html = await (await fetchOk(request, '/')).text()
    const links = [...html.matchAll(/<link rel="(icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => [m[1], m[2]])
    expect(links).toEqual([
      ['icon', '/favicon.ico'],
      ['icon', '/icon.svg'],
      ['apple-touch-icon', '/apple-touch-icon.png'],
      ['manifest', '/manifest.webmanifest'],
    ])

    const ico = await fetchOk(request, '/favicon.ico')
    expect(ico.headers()['content-type']).toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/)
    const icoBody = await ico.body()
    // ICONDIR: type 1 (icon), one image, 32x32, PNG inside
    expect([icoBody.readUInt16LE(2), icoBody.readUInt16LE(4), icoBody[6], icoBody[7]]).toEqual([1, 1, 32, 32])
    expect(pngSize(icoBody.subarray(icoBody.readUInt32LE(18)))).toEqual([32, 32])

    const svg = await fetchOk(request, '/icon.svg')
    expect(svg.headers()['content-type']).toContain('image/svg+xml')
    expect(await svg.text()).toMatch(/^<svg [^>]*viewBox="0 0 64 64"/)

    const touch = await fetchOk(request, '/apple-touch-icon.png')
    expect(touch.headers()['content-type']).toContain('image/png')
    expect(pngSize(await touch.body())).toEqual([180, 180])
  })

  test('the manifest lists 192, 512 and a maskable 512 that are served at those sizes', async ({ request }) => {
    const res = await fetchOk(request, '/manifest.webmanifest')
    expect(res.headers()['content-type']).toContain('application/manifest+json')
    const manifest = await res.json()
    expect(manifest.name).toBe('Kubeast')
    expect(manifest.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}${i.purpose ? ' ' + i.purpose : ''}`)).toEqual([
      '192x192',
      '512x512',
      '512x512 maskable',
    ])
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      const png = await fetchOk(request, icon.src)
      expect(png.headers()['content-type']).toContain(icon.type)
      expect(pngSize(await png.body()).join('x')).toBe(icon.sizes)
    }
  })

  test('the sidebar and the sign-in page show the loaded logo', async ({ page, browser }) => {
    await page.goto('/')
    const side = page.getByTestId('brand-logo')
    await expect(side).toHaveAttribute('src', '/icon.svg')
    await expect.poll(() => side.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0)

    // a fresh context has no session, so this is the sign-in page
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const login = await ctx.newPage()
      await login.goto('/login')
      const logo = login.locator('h1').getByTestId('brand-logo')
      await expect(logo).toHaveAttribute('src', '/icon.svg')
      await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0)
      await expect(login.locator('h1')).toHaveText('Kubeast')
    } finally {
      await ctx.close()
    }
  })
})
