/** A refusal because of the namespace itself (services/pkg/protectedns), which no role in the cluster would change. */
export function isProtectedNamespaceError(error: unknown): boolean {
  return (error as { response?: { data?: { reason?: string } } } | null)?.response?.data?.reason === 'protected_namespace'
}
