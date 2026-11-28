// Builds the demo into site/demo/ for GitHub Pages. Run through build.sh, which extracts the v0.8.0 console into
// .release/ and links its node_modules here. KUBEAST_DEMO_BASE sets the path the demo is served at (default
// /Kubeast/demo/, the project site; /site/demo/ or similar for a local preview).
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const release = resolve(here, '.release')
const frontend = resolve(release, 'frontend')
const outDir = resolve(here, '../site/demo')
const commit = 'ce70615c3feea0143d5cec7ed813593c8e176bd5'
const base = process.env.KUBEAST_DEMO_BASE || '/Kubeast/demo/'

if (!existsSync(resolve(release, 'SOURCE')) || readFileSync(resolve(release, 'SOURCE'), 'utf8').trim() !== commit) {
  throw new Error('site-demo/.release does not hold the v0.8.0 console; run site-demo/build.sh')
}
if (!existsSync(resolve(frontend, 'node_modules'))) throw new Error('site-demo/.release/frontend has no node_modules; run site-demo/build.sh')
if (!/^\/([^/]+\/)*$/.test(base)) throw new Error('KUBEAST_DEMO_BASE must start and end with /')

// The public files the demo needs, and no others: the console's font (with its licence) and icon.
const publicDir = resolve(release, 'public-demo')
for (const file of ['fonts/InterVariable.woff2', 'fonts/Inter-LICENSE.txt', 'icon.svg']) {
  mkdirSync(dirname(resolve(publicDir, file)), { recursive: true })
  copyFileSync(resolve(frontend, 'public', file), resolve(publicDir, file))
}

const require = createRequire(resolve(frontend, 'package.json'))
const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
const { build } = await load('vite')
const react = (await load('@vitejs/plugin-react')).default
const tailwind = (await load('@tailwindcss/vite')).default

// A few released components write the console's icon as "/icon.svg", the root of a console install. Under the project
// site that is another site's root, so the demo build points them at its own copy. The source files are not changed.
const iconUnderBase = {
  name: 'kubeast-demo-icon-path',
  enforce: 'pre',
  transform(code, id) {
    if (!id.startsWith(resolve(frontend, 'src')) || !id.endsWith('.tsx') || !code.includes('src="/icon.svg"')) return null
    return { code: code.replaceAll('src="/icon.svg"', "src={import.meta.env.BASE_URL + 'icon.svg'}"), map: null }
  },
}

// The licence and notice files of the packages in the demo's files, written beside them as THIRD-PARTY.txt (MIT,
// Apache-2.0 and the others ask for their notice to go with every copy). Monaco's workers are bundled apart, so the
// plugin reads their bundles too, and the page's bundle, which comes last, writes the file.
const bundled = new Map()
const noticeFile = /^(licen[cs]e|copying|notice|thirdpartynotices)(-[a-z0-9.]+)?(\.(md|txt|markdown))?$/i
const licenceOf = (pkg) => (typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ')) || 'not stated'
const thirdParty = (worker) => ({
  name: 'kubeast-demo-third-party',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
        const path = id.replace(/^\0/, '').split('?')[0]
        const at = path.lastIndexOf('/node_modules/')
        if (at < 0) continue
        const top = at + '/node_modules/'.length
        const name = path.slice(top).split('/')
        const dir = path.slice(0, top) + name.slice(0, name[0].startsWith('@') ? 2 : 1).join('/')
        if (!bundled.has(dir) && existsSync(join(dir, 'package.json'))) bundled.set(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
      }
    }
    if (worker) return
    const entries = [...bundled].sort(([, a], [, b]) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version)).map(([dir, pkg]) => {
      const files = readdirSync(dir).filter((file) => noticeFile.test(file) && statSync(join(dir, file)).isFile()).sort()
      return [pkg.name + ' ' + pkg.version + ' (' + licenceOf(pkg) + ')', ...files.map((file) => readFileSync(join(dir, file), 'utf8').trim())].join('\n\n')
    })
    const source = 'The packages in the files of this demo, with the licence and notice files each one ships.\n\n' + entries.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n'
    this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY.txt', source })
  },
})

await build({
  root: here,
  base,
  configFile: false,
  publicDir,
  logLevel: 'info',
  plugins: [iconUnderBase, react(), tailwind(), thirdParty(false)],
  worker: { plugins: () => [thirdParty(true)] },
  resolve: { alias: [{ find: '@', replacement: resolve(frontend, 'src') }] },
  build: { outDir, emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4096 },
})

// What the output must not hold: a local path or address, or a request to another host than the page's.
const forbidden = [/\/Users\//, /127\.0\.0\.1/, /localhost:\d/, /\.release\//]
const files = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); statSync(path).isDirectory() ? walk(path) : files.push(path) } }
walk(outDir)
for (const file of files.filter((f) => /\.(html|js|css|json)$/.test(f))) {
  const text = readFileSync(file, 'utf8')
  for (const rule of forbidden) if (rule.test(text)) throw new Error(file + ' holds ' + rule)
}
writeFileSync(resolve(outDir, 'demo-source.json'), JSON.stringify({ release: 'v0.8.0', commit, entry: 'site-demo/main.tsx', base, files: files.length }, null, 2) + '\n')
console.log('demo built into ' + outDir + ' (' + files.length + ' files, base ' + base + ')')
