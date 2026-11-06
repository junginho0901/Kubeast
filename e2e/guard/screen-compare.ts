import type { Page } from '@playwright/test'

// The picture comparison of safety net (b), e2e/guard/screen-diff.spec.ts: two PNGs compared pixel by pixel in a browser
// page, with no new dependency. A pixel differs when a colour channel moved by more than TOLERANCE of 255. A browser
// also redraws an icon's edge a little differently from one load to the next (measured on one build against itself: up
// to 10 pixels, none past 23 of 255), so that few pixels that faint count as none; a changed digit moves dozens of pixels
// by far more, and a changed colour many. The picture it returns has the differing pixels in red over a faded copy of
// the first picture.

export const TOLERANCE = 8
export const FAINT_PIXELS = 12
export const FAINT_DELTA = 32

export type Box = { x: number; y: number; width: number; height: number }
export type Compared = { pixels: number; box: Box | null; size: string; marked: Buffer | null }

export async function comparePictures(page: Page, a: Buffer, b: Buffer): Promise<Compared> {
  if (a.equals(b)) return { pixels: 0, box: null, size: '', marked: null }
  const out = await page.evaluate(async ({ a, b, tolerance, faintPixels, faintDelta }) => {
    const load = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height) }
    }
    const [one, two] = await Promise.all([load(a), load(b)])
    const width = Math.max(one.width, two.width)
    const height = Math.max(one.height, two.height)
    const size = one.width === two.width && one.height === two.height ? `${width}x${height}` : `${one.width}x${one.height} / ${two.width}x${two.height}`
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')!
    const marked = context.createImageData(width, height)
    let pixels = 0
    let strongest = 0
    let left = width, top = height, right = -1, bottom = -1
    const at = (image: typeof one, x: number, y: number) => (x < image.width && y < image.height ? (y * image.width + x) * 4 : -1)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = at(one, x, y)
        const j = at(two, x, y)
        const p = one.data.data
        const q = two.data.data
        const delta = i < 0 || j < 0 ? 255 : Math.max(Math.abs(p[i] - q[j]), Math.abs(p[i + 1] - q[j + 1]), Math.abs(p[i + 2] - q[j + 2]))
        const differs = delta > tolerance
        if (differs) strongest = Math.max(strongest, delta)
        const k = (y * width + x) * 4
        if (differs) {
          pixels++
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
          marked.data[k] = 255; marked.data[k + 1] = 0; marked.data[k + 2] = 0; marked.data[k + 3] = 255
        } else {
          const grey = (p[i] + p[i + 1] + p[i + 2]) / 3
          marked.data[k] = marked.data[k + 1] = marked.data[k + 2] = 128 + grey / 4
          marked.data[k + 3] = 255
        }
      }
    }
    if (pixels === 0 || (pixels <= faintPixels && strongest <= faintDelta)) return { pixels: 0, box: null, size, marked: null }
    context.putImageData(marked, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const buffer = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (let n = 0; n < buffer.length; n += 32768) text += String.fromCharCode(...buffer.subarray(n, n + 32768))
    return { pixels, box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, size, marked: btoa(text) }
  }, { a: a.toString('base64'), b: b.toString('base64'), tolerance: TOLERANCE, faintPixels: FAINT_PIXELS, faintDelta: FAINT_DELTA })
  return { ...out, marked: out.marked ? Buffer.from(out.marked, 'base64') : null }
}

// A screen change a PR means to make: which screens, why, and the PR. A rule with no reason or PR is refused; the file's
// changes show in the diff of whichever PR adds to it.
export type IntendedRule = { screen: string; why: string; pr: string }
export function compileIntended(rules: IntendedRule[]): (screen: string) => IntendedRule | null {
  const compiled = rules.map((r) => {
    if (!r.why?.trim() || !r.pr?.trim()) throw new Error(`an intended change needs a reason and a PR: ${JSON.stringify(r)}`)
    return { rule: r, screen: new RegExp(r.screen) }
  })
  return (screen) => compiled.find((c) => c.screen.test(screen))?.rule ?? null
}
