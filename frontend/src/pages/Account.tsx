import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/services/api'
import { ChevronDown, Database, KeyRound, Languages, Loader2, Terminal, Trash2, User, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from '@/components/ModalOverlay'
import { loadNodeShellSettings, saveNodeShellSettings } from '@/services/nodeShellSettings'

export default function Account() {
  const queryClient = useQueryClient()
  const { t, i18n } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30000, retry: false })

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false)
  const languageDropdownRef = useRef<HTMLDivElement>(null)
  const [nodeShellEnabled, setNodeShellEnabled] = useState(loadNodeShellSettings().isEnabled)
  const [nodeShellNamespace, setNodeShellNamespace] = useState(loadNodeShellSettings().namespace)
  const [nodeShellImage, setNodeShellImage] = useState(loadNodeShellSettings().linuxImage)
  const [clusterModalOpen, setClusterModalOpen] = useState(false)
  const [clusterName, setClusterName] = useState('')
  const [clusterMode, setClusterMode] = useState<'in_cluster' | 'external'>('in_cluster')
  const [clusterKubeconfig, setClusterKubeconfig] = useState('')
  const [clusterError, setClusterError] = useState<string | null>(null)

  const changePasswordMutation = useMutation({
    mutationFn: () => api.changePassword({ current_password: currentPassword, new_password: newPassword }),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setLocalError(null)
      setSuccess(tr('account.password.changed', 'Password updated.'))
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: () => {
      setSuccess(null)
    },
  })

  const isBusy = changePasswordMutation.isPending
  const language = i18n.language?.startsWith('ko') ? 'ko' : 'en'
  const isAdmin = (me?.role || '').toLowerCase() === 'admin'

  const { data: clusterConnections, isLoading: isClusterLoading } = useQuery({
    queryKey: ['cluster-connections'],
    queryFn: api.listClusterConnections,
    enabled: isAdmin,
  })

  const createClusterMutation = useMutation({
    mutationFn: () =>
      api.createClusterConnection({
        name: clusterName.trim(),
        mode: clusterMode,
        kubeconfig: clusterMode === 'external' ? clusterKubeconfig.trim() : undefined,
      }),
    onSuccess: () => {
      setClusterName('')
      setClusterMode('in_cluster')
      setClusterKubeconfig('')
      setClusterError(null)
      setClusterModalOpen(false)
      queryClient.invalidateQueries({ queryKey: ['cluster-connections'] })
    },
    onError: (err: any) => {
      setClusterError(err?.response?.data?.detail || tr('account.cluster.errors.failed', 'Failed to save cluster.'))
    },
  })

  const activateClusterMutation = useMutation({
    mutationFn: (id: string) => api.activateClusterConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster-connections'] })
    },
  })

  const deleteClusterMutation = useMutation({
    mutationFn: (id: string) => api.deleteClusterConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cluster-connections'] })
    },
  })

  const setLanguage = (next: 'en' | 'ko') => {
    if (language === next) return
    void i18n.changeLanguage(next)
  }

  useEffect(() => {
    if (!isLanguageDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (languageDropdownRef.current && !languageDropdownRef.current.contains(event.target as Node)) {
        setIsLanguageDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isLanguageDropdownOpen])

  const closePasswordModal = () => {
    setPasswordModalOpen(false)
    setLocalError(null)
    setSuccess(null)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    changePasswordMutation.reset()
  }

  useEffect(() => {
    saveNodeShellSettings({
      isEnabled: nodeShellEnabled,
      namespace: nodeShellNamespace.trim() || 'default',
      linuxImage: nodeShellImage.trim() || 'docker.io/library/busybox:latest',
    })
  }, [nodeShellEnabled, nodeShellNamespace, nodeShellImage])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSuccess(null)
    if (!currentPassword || !newPassword) {
      setLocalError(tr('account.password.required', 'Enter current and new passwords.'))
      return
    }
    if (newPassword !== confirmPassword) {
      setLocalError(tr('account.password.mismatch', 'New passwords do not match.'))
      return
    }
    setLocalError(null)
    changePasswordMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">{tr('account.title', 'Settings')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('account.subtitle', 'Manage your profile, password, and language.')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <div className="card">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary-500/10">
                <User className="w-6 h-6 text-primary-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">{tr('account.profile.title', 'Profile')}</h2>
                <p className="text-sm text-slate-400">
                  {tr('account.profile.subtitle', 'Signed-in account information')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPasswordModalOpen(true)}
              className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700/40"
            >
              {tr('account.password.open', 'Change password')}
            </button>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-400">{tr('account.profile.name', 'Name')}</div>
            <div className="mt-1 text-sm text-white">{me?.name ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">{tr('account.profile.email', 'Email')}</div>
            <div className="mt-1 text-sm text-white">{me?.email ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">{tr('account.profile.hq', 'HQ')}</div>
            <div className="mt-1 text-sm text-white">{me?.hq ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">{tr('account.profile.team', 'Team')}</div>
            <div className="mt-1 text-sm text-white">{me?.team ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">{tr('account.profile.role', 'Role')}</div>
            <div className="mt-1 text-sm text-white">{me?.role ?? '-'}</div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-sky-500/10">
              <Terminal className="w-6 h-6 text-sky-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{tr('account.nodeShell.title', 'Node Shell')}</h2>
              <p className="text-sm text-slate-400">
                {tr('account.nodeShell.subtitle', 'Configure debug shell settings for nodes.')}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-white">
                  {tr('account.nodeShell.enable', 'Enable Node Shell')}
                </div>
                <div className="text-xs text-slate-400">
                  {tr('account.nodeShell.enableHint', 'Show debug shell action in node details.')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNodeShellEnabled((prev) => !prev)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                  nodeShellEnabled ? 'bg-emerald-500' : 'bg-slate-700'
                }`}
                aria-pressed={nodeShellEnabled}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                    nodeShellEnabled ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div>
              <div className="text-xs text-slate-400 mb-1">
                {tr('account.nodeShell.namespace', 'Namespace')}
              </div>
              <input
                type="text"
                value={nodeShellNamespace}
                onChange={(e) => setNodeShellNamespace(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200"
              />
            </div>

            <div>
              <div className="text-xs text-slate-400 mb-1">
                {tr('account.nodeShell.image', 'Linux image')}
              </div>
              <input
                type="text"
                value={nodeShellImage}
                onChange={(e) => setNodeShellImage(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200"
              />
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="card">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <Database className="w-6 h-6 text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">{tr('account.cluster.title', 'Cluster connections')}</h2>
                  <p className="text-sm text-slate-400">
                    {tr('account.cluster.subtitle', 'Register and switch clusters managed by this UI.')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setClusterModalOpen(true)}
                className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700/40"
              >
                {tr('account.cluster.add', 'Add cluster')}
              </button>
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-900/40">
              {isClusterLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tr('account.cluster.loading', 'Loading clusters...')}
                </div>
              ) : (clusterConnections || []).length === 0 ? (
                <div className="px-4 py-6 text-sm text-slate-400">
                  {tr('account.cluster.empty', 'No registered clusters yet.')}
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {(clusterConnections || []).map((cluster) => {
                    const isActive = Boolean(cluster.is_active)
                    return (
                      <div key={cluster.id} className="flex items-center justify-between px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold text-white flex items-center gap-2">
                            {cluster.name}
                            {isActive && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                                {tr('account.cluster.active', 'Active')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400">
                            {cluster.mode === 'in_cluster'
                              ? tr('account.cluster.mode.incluster', 'In-cluster')
                              : tr('account.cluster.mode.external', 'External')}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isActive || activateClusterMutation.isPending}
                            onClick={() => activateClusterMutation.mutate(cluster.id)}
                            className="rounded-lg border border-slate-700 bg-slate-900/40 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700/40 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {activateClusterMutation.isPending && activateClusterMutation.variables === cluster.id
                              ? tr('account.cluster.activating', 'Activating...')
                              : tr('account.cluster.activate', 'Activate')}
                          </button>
                          <button
                            type="button"
                            disabled={deleteClusterMutation.isPending}
                            onClick={() => deleteClusterMutation.mutate(cluster.id)}
                            className="rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Languages className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{tr('account.language.title', 'Language')}</h2>
              <p className="text-sm text-slate-400">
                {tr('account.language.subtitle', 'Choose the display language.')}
              </p>
            </div>
          </div>

          <div className="relative w-full max-w-xs" ref={languageDropdownRef}>
            <button
              type="button"
              onClick={() => setIsLanguageDropdownOpen((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/40"
              aria-haspopup="listbox"
              aria-expanded={isLanguageDropdownOpen}
            >
              <span>
                {language === 'ko'
                  ? tr('account.language.korean', 'Korean')
                  : tr('account.language.english', 'English')}
              </span>
              <ChevronDown
                className={`h-4 w-4 text-slate-400 transition-transform ${
                  isLanguageDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            {isLanguageDropdownOpen && (
              <div className="absolute z-20 mt-2 w-full rounded-lg border border-slate-700 bg-slate-900/95 p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setLanguage('en')
                    setIsLanguageDropdownOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm ${
                    language === 'en'
                      ? 'bg-primary-600/20 text-white'
                      : 'text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {tr('account.language.english', 'English')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLanguage('ko')
                    setIsLanguageDropdownOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm ${
                    language === 'ko'
                      ? 'bg-primary-600/20 text-white'
                      : 'text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {tr('account.language.korean', 'Korean')}
                </button>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            {tr('account.language.hint', 'Changes apply immediately.')}
          </p>
        </div>
      </div>

      {passwordModalOpen && (
        <ModalOverlay onClose={closePasswordModal}>
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={tr('account.password.title', 'Change password')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <KeyRound className="w-6 h-6 text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {tr('account.password.title', 'Change password')}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {tr('account.password.subtitle', 'Verify your current password')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closePasswordModal}
                className="rounded-lg border border-slate-700 bg-slate-900/40 p-2 text-slate-300 hover:bg-slate-700/40"
                aria-label={tr('account.password.close', 'Close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {success && (
              <div className="mt-4 rounded-lg border border-green-900/40 bg-green-950/30 px-3 py-2 text-sm text-green-200">
                {success}
              </div>
            )}

            {(localError || changePasswordMutation.isError) && (
              <div className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                {localError ?? tr('account.password.failed', 'Failed to change password.')}
              </div>
            )}

            <form onSubmit={onSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('account.password.current', 'Current password')}
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('account.password.new', 'New password')}
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('account.password.minLength', 'At least 4 characters')}
                  autoComplete="new-password"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('account.password.confirm', 'Confirm new password')}
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('account.password.confirmPlaceholder', 'Type again')}
                  autoComplete="new-password"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closePasswordModal}
                  className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700/40"
                >
                  {tr('account.password.cancel', 'Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isBusy}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy
                    ? tr('account.password.updating', 'Updating...')
                    : tr('account.password.submit', 'Update password')}
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {clusterModalOpen && (
        <ModalOverlay onClose={() => setClusterModalOpen(false)}>
          <div
            className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950/95 p-6 shadow-2xl backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">
                  {tr('account.cluster.modal.title', 'Add cluster connection')}
                </h3>
                <button type="button" onClick={() => setClusterModalOpen(false)}>
                  <X className="h-5 w-5 text-slate-400 hover:text-white" />
                </button>
              </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('account.cluster.modal.name', 'Name')}
                </label>
                <input
                  value={clusterName}
                  onChange={(e) => setClusterName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('account.cluster.modal.mode', 'Mode')}
                </label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setClusterMode('in_cluster')}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      clusterMode === 'in_cluster'
                        ? 'border-primary-500/50 bg-primary-500/10 text-primary-200'
                        : 'border-slate-700 bg-slate-900/40 text-slate-300'
                    }`}
                  >
                    {tr('account.cluster.mode.incluster', 'In-cluster')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setClusterMode('external')}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      clusterMode === 'external'
                        ? 'border-primary-500/50 bg-primary-500/10 text-primary-200'
                        : 'border-slate-700 bg-slate-900/40 text-slate-300'
                    }`}
                  >
                    {tr('account.cluster.mode.external', 'External')}
                  </button>
                </div>
              </div>

              {clusterMode === 'external' && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    {tr('account.cluster.modal.kubeconfig', 'Kubeconfig')}
                  </label>
                  <textarea
                    value={clusterKubeconfig}
                    onChange={(e) => setClusterKubeconfig(e.target.value)}
                    className="h-40 w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-200"
                  />
                </div>
              )}
            </div>

            {clusterError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {clusterError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClusterModalOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700/40"
              >
                {tr('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                disabled={createClusterMutation.isPending || !clusterName.trim()}
                onClick={() => createClusterMutation.mutate()}
                className="rounded-lg bg-primary-600 px-3 py-2 text-xs font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createClusterMutation.isPending
                  ? tr('account.cluster.modal.saving', 'Saving...')
                  : tr('account.cluster.modal.save', 'Save')}
              </button>
            </div>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
