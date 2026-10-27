import type { JSX } from 'react'
import RequirePermission from './RequirePermission'
import { ADMIN_PAGE_PERMISSIONS } from '@/utils/adminAccess'

// An admin page opens for the permissions that page needs (utils/adminAccess), as the sidebar shows it — not only
// for a full admin.
export default function RequireAdmin({ page, children }: { page: keyof typeof ADMIN_PAGE_PERMISSIONS; children: JSX.Element }) {
  return <RequirePermission permission={ADMIN_PAGE_PERMISSIONS[page]}>{children}</RequirePermission>
}
