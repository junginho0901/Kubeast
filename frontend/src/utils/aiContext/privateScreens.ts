// Screens whose content never goes to the model: the admin pages (users, roles, audit, AI models …) and the account
// page. Cluster hygiene and alert investigations hold no personal data, so the floating chat reads them.
// The ai-service floating prompt names the same two paths (app/prompts/floating_system_prompt.py).
export const READABLE_ADMIN_PATHS = ['/admin/cluster-hygiene', '/admin/investigations']

export function isPrivateScreen(path: string): boolean {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
  if (under('/account')) return true
  return under('/admin') && !READABLE_ADMIN_PATHS.some(under)
}
