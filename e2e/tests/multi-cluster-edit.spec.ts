import { test, expect } from '@playwright/test'

// Admin > Clusters Edit dialog (kubeconfig rotation / rename). Previously a
// registered cluster could only be Tested or Deleted — but delete + re-register
// CASCADE-drops all per-cluster RBAC grants. Edit keeps the id (and grants):
// rename here; kubeconfig rotation is guarded server-side by the kube-system UID
// match (verified at the API level — a different cluster's kubeconfig → 409).
//
// Self-cleaning: renames test2 then restores it, so it leaves no drift.

test.describe('multi-cluster cluster edit', () => {
  test('rename a cluster via the Edit dialog (id + grants preserved)', async ({ page }) => {
    await page.goto('/admin/clusters')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('clusters-table')).toBeVisible({ timeout: 15000 })

    // Edit replaces the old Test/Delete-only actions.
    const edit = page.getByTestId('edit-cluster-test2')
    await expect(edit).toBeVisible()
    await edit.click()

    const name = page.getByTestId('edit-name')
    await expect(name).toBeVisible()
    // external cluster → kubeconfig rotation field is offered
    await expect(page.getByTestId('edit-kubeconfig')).toBeVisible()

    await name.fill('test2-edited')
    await page.getByTestId('edit-submit').click()
    await expect(page.getByTestId('clusters-table')).toContainText('test2-edited', { timeout: 10000 })

    // restore
    await page.getByTestId('edit-cluster-test2').click()
    await page.getByTestId('edit-name').fill('test2')
    await page.getByTestId('edit-submit').click()
    await expect(page.getByTestId('clusters-table')).not.toContainText('test2-edited', { timeout: 10000 })
  })
})
