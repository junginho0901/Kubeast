import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Audit log integrity: auth-service seals every audit row into a hash chain
// (chain_seq / prev_hash / row_hash) and anchors the chain head as a digest in
// the dev S3 stand-in (audit.integrity.anchor.sink = dev-s3). The spec makes a
// row of its own, waits for it to be sealed, verifies the range, changes that
// row straight in the dev database (kubectl exec into the postgres pod of the
// kind cluster — never the shell's default kubeconfig), sees the verification
// fail at it, restores it, anchors now and checks the digest object and the
// admin page. Skips when the feature is off.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const stamp = Date.now().toString(36)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

// The canonical row expression, as in services/auth-service-go/internal/auditchain (CanonSQL).
const CANON =
  "concat_ws(E'\\x1f', id, coalesce(service,''), action, coalesce(actor_user_id,''), coalesce(actor_email,''), coalesce(target_user_id,''), coalesce(target_email,''), coalesce(target_type,''), coalesce(target_id,''), coalesce(before::text,''), coalesce(after::text,''), coalesce(request_ip,''), coalesce(user_agent,''), coalesce(request_id,''), coalesce(path,''), coalesce(cluster,''), coalesce(namespace,''), result, coalesce(error,''), to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US'))"

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function kubectl(args: string[]): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', args, { env: { ...process.env, KUBECONFIG }, encoding: 'utf8', maxBuffer: 16 << 20 }).trim()
}
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function verify(request: APIRequestContext, admin: string, body: Record<string, unknown>) {
  const res = await request.post('/api/v1/auth/admin/audit/integrity/verify', { headers: bearer(admin), data: body })
  expect(res.ok(), `verify: ${res.status()} ${await res.text()}`).toBeTruthy()
  return res.json()
}

test.describe('Audit log integrity', () => {
  let admin = ''
  let status: { enabled: boolean; anchor_sink?: string; sealed_through_seq: number }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    status = await (await request.get('/api/v1/auth/admin/audit/integrity', { headers: bearer(admin) })).json()
    test.skip(!status.enabled, 'AUDIT_INTEGRITY_ENABLED is off on this installation')
  })

  test('seals new rows into the chain and catches a row changed in the database', async ({ request }) => {
    // A row of our own: a failed login for a unique address is audited as user.login.failed.
    const email = `e2e-chain-${stamp}@example.com`
    await request.post('/api/v1/auth/login', { data: { email, password: 'not-the-password' }, failOnStatusCode: false })
    const id = Number(psql(`select max(id) from auth_audit_logs where action='user.login.failed' and target_email='${email}'`))
    expect(id, 'the failed login is audited').toBeGreaterThan(0)

    // Sealed within a few seal intervals (10 s in dev).
    await expect.poll(() => psql(`select coalesce(chain_seq,0) from auth_audit_logs where id=${id}`), { timeout: 45_000, intervals: [2000] }).not.toBe('0')
    const seq = Number(psql(`select chain_seq from auth_audit_logs where id=${id}`))

    // The stored hash is what psql recomputes with the documented one-liner (no Kubeast involved).
    const recomputed = psql(`select encode(row_hash,'hex') = encode(sha256(prev_hash || '\\x1e'::bytea || convert_to(${CANON}, 'UTF8')), 'hex') from auth_audit_logs where id=${id}`)
    expect(recomputed, 'psql recomputation matches the stored hash').toBe('t')

    const range = { from_seq: Math.max(1, seq - 50), to_seq: seq }
    let rep = await verify(request, admin, range)
    expect(rep.ok, JSON.stringify(rep)).toBe(true)
    expect(rep.to_seq).toBe(seq)

    // Change the row behind Kubeast's back: the chain breaks at exactly that position.
    const originalAgent = psql(`select coalesce(user_agent,'') from auth_audit_logs where id=${id}`)
    psql(`update auth_audit_logs set user_agent = 'tampered by e2e' where id=${id}`)
    try {
      rep = await verify(request, admin, range)
      expect(rep.ok).toBe(false)
      expect(rep.reason).toBe('hash_mismatch')
      expect(rep.first_bad_seq).toBe(seq)
    } finally {
      psql(`update auth_audit_logs set user_agent = nullif('${originalAgent.replace(/'/g, "''")}', '') where id=${id}`)
    }
    rep = await verify(request, admin, range)
    expect(rep.ok, 'restored row verifies again').toBe(true)

    // The verification runs are audited.
    const list = await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.audit.verify&limit=5', { headers: bearer(admin) })).json()
    expect(list.items.length).toBeGreaterThanOrEqual(3)
  })

  test('anchors the chain head as a digest in the S3 stand-in and verifies against it', async ({ request }) => {
    test.skip(!status.anchor_sink, 'no anchor sink on this installation')
    const res = await request.post('/api/v1/auth/admin/audit/integrity/anchor', { headers: bearer(admin) })
    expect(res.ok(), `anchor: ${res.status()} ${await res.text()}`).toBeTruthy()
    const anchor = await res.json()
    expect(anchor.object_key).toMatch(/^digests\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z-\d+-\d+\.json$/)
    expect(anchor.actor).toBe(ADMIN_EMAIL)

    // The digest object is in the stand-in under the sink's prefix and says what the anchor row says.
    const file = kubectl(['-n', 'kubeast-devtools', 'exec', 'deploy/s3', '--', 'find', '/data/objects/kubeast-audit/audit/digests', '-name', path.basename(anchor.object_key)])
    expect(file, 'digest object exists').toContain(anchor.object_key.replace(/^digests\//, 'digests/'))
    const b64 = kubectl(['-n', 'kubeast-devtools', 'exec', 'deploy/s3', '--', 'base64', file.split('\n')[0]]).replace(/\s/g, '')
    const digest = JSON.parse(Buffer.from(b64, 'base64').toString())
    expect(digest.version).toBe(1)
    expect(digest.to_seq).toBe(anchor.to_seq)
    expect(digest.rows).toBe(anchor.rows)
    expect(digest.hash_algorithm).toBe('SHA-256')
    expect(Array.isArray(digest.access_reviews)).toBe(true)
    if (anchor.rows > 0) {
      expect(digest.head_hash).toBe(psql(`select encode(row_hash,'hex') from auth_audit_logs where chain_seq=${anchor.to_seq}`))
    }

    const st = await (await request.get('/api/v1/auth/admin/audit/integrity', { headers: bearer(admin) })).json()
    expect(st.last_anchor?.id).toBe(anchor.id)

    // Default range + objects: the anchor's head matches the chain and the object matches the anchor row.
    const rep = await verify(request, admin, { anchors: true })
    expect(rep.ok, JSON.stringify(rep)).toBe(true)
    const mine = rep.anchors.find((a: { id: number }) => a.id === anchor.id)
    expect(mine, 'the new anchor is in the default range').toBeTruthy()
    expect(mine.head_ok).toBe(true)
    expect(mine.object_ok).toBe(true)
    const rows = await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.audit.anchor&limit=1', { headers: bearer(admin) })).json()
    expect(rows.items[0]?.ActorEmail).toBe(ADMIN_EMAIL)
  })

  test('Admin → Audit log shows the chain state, verifies and anchors from the page', async ({ page, request }) => {
    await page.goto('/admin/audit')
    const strip = page.getByTestId('audit-integrity')
    await expect(strip).toBeVisible({ timeout: 15_000 })
    await expect(strip).toContainText('#')
    await page.getByTestId('audit-integrity-verify').click()
    await expect(page.getByTestId('audit-integrity-result')).toContainText('✓', { timeout: 30_000 })
    if (status.anchor_sink) {
      // The strip's text can repeat (same second, no new rows), so the new anchor is checked by id.
      const lastAnchorId = async () => (await (await request.get('/api/v1/auth/admin/audit/integrity', { headers: bearer(admin) })).json()).last_anchor?.id ?? 0
      const before = await lastAnchorId()
      await page.getByTestId('audit-integrity-anchor').click()
      await expect.poll(lastAnchorId, { timeout: 15_000 }).toBeGreaterThan(before)
      await expect(page.getByTestId('audit-integrity-anchor-state')).toContainText('#')
    }
  })
})
