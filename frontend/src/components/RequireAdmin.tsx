import RequirePermission from './RequirePermission'

export default function RequireAdmin({ children }: { children: JSX.Element }) {
  return <RequirePermission permission="admin.*">{children}</RequirePermission>
}
