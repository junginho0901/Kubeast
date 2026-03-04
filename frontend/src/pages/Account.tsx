import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/services/api'
import { ChevronDown, KeyRound, Languages, Terminal, User, X } from 'lucide-react'
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
    </div>
  )
}
