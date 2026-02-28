import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useMemo, useState, useEffect, type ComponentType } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowRight,
  Box,
  Boxes,
  Clock,
  Database,
  FileBox,
  FileCode,
  HardDrive,
  Key,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Network,
  Search,
  Server,
  Shield,
  Waypoints,
} from 'lucide-react'
import { api } from '@/services/api'
import { clearAccessToken } from '@/services/auth'

type NavItem = {
  name: string
  href: string
  icon?: ComponentType<{ className?: string }>
  exact?: boolean
  match?: (pathname: string, search: string) => boolean
}

type NavGroup = {
  id: string
  label: string
  items: NavItem[]
  adminOnly?: boolean
}

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [clusterStatus, setClusterStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking')

  const {
    data: me,
    isError: isMeError,
  } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })

  useEffect(() => {
    if (!isMeError) return
    clearAccessToken()
    queryClient.clear()
    navigate('/login')
  }, [isMeError, navigate, queryClient])

  useEffect(() => {
    const checkClusterStatus = async () => {
      try {
        const health = await api.getHealth()
        setClusterStatus(health.kubernetes === 'connected' ? 'connected' : 'disconnected')
      } catch (error) {
        setClusterStatus('disconnected')
      }
    }

    checkClusterStatus()
    const interval = setInterval(checkClusterStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleLogout = () => {
    // Best-effort: clear HttpOnly auth cookie (for WS/SSE auth) as well.
    void api.logout().catch(() => {})
    clearAccessToken()
    queryClient.clear()
    navigate('/login')
  }

  const { t } = useTranslation()
  const isAdmin = me?.role === 'admin'
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ core: true })

  const storageTabMatch = (tab: string, pathname: string, search: string) => {
    if (!pathname.startsWith('/storage')) return false
    const current = new URLSearchParams(search).get('tab') || 'pvcs'
    return current === tab
  }

  const navGroups: NavGroup[] = useMemo(() => [
    {
      id: 'core',
      label: t('nav.core'),
      items: [
        { name: t('nav.dashboard'), href: '/', icon: LayoutDashboard, exact: true },
        { name: t('nav.clusterView'), href: '/cluster-view', icon: Layers },
        { name: t('nav.monitoring'), href: '/monitoring', icon: Activity },
        { name: t('nav.aiChat'), href: '/ai-chat', icon: MessageSquare },
      ],
    },
    {
      id: 'cluster',
      label: t('nav.cluster'),
      items: [
        { name: t('nav.namespaces'), href: '/cluster/namespaces', icon: Boxes },
        { name: t('nav.nodes'), href: '/cluster/nodes', icon: Server },
        { name: t('nav.advancedSearch'), href: '/cluster/search', icon: Search },
      ],
    },
    {
      id: 'workloads',
      label: t('nav.workloads'),
      items: [
        { name: t('nav.pods'), href: '/workloads/pods', icon: Box },
        { name: t('nav.deployments'), href: '/workloads/deployments', icon: Layers },
        { name: t('nav.statefulSets'), href: '/workloads/statefulsets', icon: Database },
        { name: t('nav.daemonSets'), href: '/workloads/daemonsets', icon: Server },
        { name: t('nav.replicaSets'), href: '/workloads/replicasets', icon: Boxes },
        { name: t('nav.jobs'), href: '/workloads/jobs', icon: FileBox },
        { name: t('nav.cronJobs'), href: '/workloads/cronjobs', icon: Clock },
      ],
    },
    {
      id: 'storage',
      label: t('nav.storage'),
      items: [
        {
          name: t('nav.pvcs'),
          href: '/storage?tab=pvcs',
          icon: Database,
          match: (pathname, search) => storageTabMatch('pvcs', pathname, search),
        },
        {
          name: t('nav.pvs'),
          href: '/storage?tab=pvs',
          icon: HardDrive,
          match: (pathname, search) => storageTabMatch('pvs', pathname, search),
        },
        {
          name: t('nav.storageClasses'),
          href: '/storage?tab=storageclasses',
          icon: Layers,
          match: (pathname, search) => storageTabMatch('storageclasses', pathname, search),
        },
        {
          name: t('nav.volumeAttachments'),
          href: '/storage?tab=volumeattachments',
          icon: Waypoints,
          match: (pathname, search) => storageTabMatch('volumeattachments', pathname, search),
        },
      ],
    },
    {
      id: 'network',
      label: t('nav.network'),
      items: [
        { name: t('nav.services'), href: '/network/services', icon: Network },
        { name: t('nav.endpoints'), href: '/network/endpoints', icon: Server },
        { name: t('nav.endpointSlices'), href: '/network/endpointslices', icon: Waypoints },
        { name: t('nav.ingresses'), href: '/network/ingresses', icon: ArrowRight },
        { name: t('nav.ingressClasses'), href: '/network/ingressclasses', icon: FileCode },
        { name: t('nav.networkPolicies'), href: '/network/networkpolicies', icon: Shield },
      ],
    },
    {
      id: 'gateway',
      label: t('nav.gateway'),
      items: [
        { name: t('nav.gateways'), href: '/gateway/gateways', icon: Waypoints },
        { name: t('nav.gatewayClasses'), href: '/gateway/gatewayclasses', icon: FileCode },
        { name: t('nav.httpRoutes'), href: '/gateway/httproutes', icon: ArrowRight },
        { name: t('nav.grpcRoutes'), href: '/gateway/grpcroutes', icon: ArrowRight },
        { name: t('nav.referenceGrants'), href: '/gateway/referencegrants', icon: Key },
        { name: t('nav.backendTlsPolicies'), href: '/gateway/backendtlspolicies', icon: Shield },
        { name: t('nav.backendTrafficPolicies'), href: '/gateway/backendtrafficpolicies', icon: Network },
      ],
    },
    {
      id: 'security',
      label: t('nav.security'),
      items: [
        { name: t('nav.serviceAccounts'), href: '/security/serviceaccounts', icon: Key },
        { name: t('nav.roles'), href: '/security/roles', icon: Shield },
        { name: t('nav.roleBindings'), href: '/security/rolebindings', icon: Shield },
      ],
    },
    {
      id: 'configuration',
      label: t('nav.configuration'),
      items: [
        { name: t('nav.configMaps'), href: '/configuration/configmaps', icon: FileCode },
        { name: t('nav.secrets'), href: '/configuration/secrets', icon: Key },
        { name: t('nav.hpas'), href: '/configuration/hpas', icon: Activity },
        { name: t('nav.vpas'), href: '/configuration/vpas', icon: Activity },
        { name: t('nav.pdbs'), href: '/configuration/pdbs', icon: Shield },
        { name: t('nav.resourceQuotas'), href: '/configuration/resourcequotas', icon: Database },
        { name: t('nav.limitRanges'), href: '/configuration/limitranges', icon: Layers },
        { name: t('nav.priorityClasses'), href: '/configuration/priorityclasses', icon: Activity },
        { name: t('nav.runtimeClasses'), href: '/configuration/runtimeclasses', icon: Server },
        { name: t('nav.leases'), href: '/configuration/leases', icon: Clock },
        { name: t('nav.mutatingWebhooks'), href: '/configuration/mutatingwebhookconfigurations', icon: FileCode },
        { name: t('nav.validatingWebhooks'), href: '/configuration/validatingwebhookconfigurations', icon: FileCode },
      ],
    },
    {
      id: 'customResources',
      label: t('nav.customResources'),
      items: [
        { name: t('nav.customInstances'), href: '/custom-resources/instances', icon: FileBox },
        { name: t('nav.customGroups'), href: '/custom-resources/groups', icon: FileCode },
      ],
    },
    {
      id: 'admin',
      label: t('nav.admin'),
      adminOnly: true,
      items: [{ name: t('nav.userManagement'), href: '/admin/users', icon: Shield }],
    },
  ], [t])

  const activeGroup = useMemo(() => {
    for (const group of navGroups) {
      if (group.adminOnly && !isAdmin) continue
      for (const item of group.items) {
        const isActive = item.match
          ? item.match(location.pathname, location.search)
          : item.exact
            ? location.pathname === item.href
            : location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)
        if (isActive) return group.id
      }
    }
    return null
  }, [isAdmin, location.pathname, location.search, navGroups])

  useEffect(() => {
    if (!activeGroup) return
    setOpenGroups((prev) => ({ ...prev, [activeGroup]: true }))
  }, [activeGroup])

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next: Record<string, boolean> = {}
      const willOpen = !prev[groupId]
      for (const key of Object.keys(prev)) {
        next[key] = false
      }
      next[groupId] = willOpen
      return next
    })
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="fixed inset-y-0 left-0 w-64 bg-slate-800 border-r border-slate-700">
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 border-b border-slate-700 h-[100px]">
            <Activity className="w-8 h-8 text-primary-500" />
            <div>
              <h1 className="text-xl font-bold text-white">K8s DevOps</h1>
              <p className="text-xs text-slate-400">Assistant</p>
            </div>
          </div>

          <nav className="flex-1 px-4 py-6 space-y-3 overflow-y-auto">
            {navGroups
              .filter((group) => (group.adminOnly ? isAdmin : true))
              .map((group) => (
                <div key={group.label} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className={`w-full flex items-center px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] transition-colors ${
                      openGroups[group.id] ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>{group.label}</span>
                  </button>
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                      openGroups[group.id] ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-1">
                      {group.items.map((item) => {
                        const isActive = item.match
                          ? item.match(location.pathname, location.search)
                          : item.exact
                            ? location.pathname === item.href
                            : location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)
                        const Icon = item.icon
                        return (
                          <Link
                            key={item.href}
                            to={item.href}
                            className={`
                              flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors
                              ${isActive ? 'bg-primary-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}
                            `}
                          >
                            {Icon && <Icon className="w-4 h-4" />}
                            <span className="font-medium">{item.name}</span>
                          </Link>
                        )
                      })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
          </nav>

          <div className="px-6 py-4">
            <Link
              to="/account"
              className="block rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 hover:bg-slate-700/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600"
              title={t('layout.accountTitle')}
            >
              <div className="text-[11px] text-slate-400">{t('layout.account')}</div>
              <div className="mt-0.5 truncate text-sm text-white">{me?.name ?? '...'}</div>
              <div className="truncate text-xs text-slate-400">{me?.email ?? ''}</div>
            </Link>

            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/40"
            >
              <LogOut className="w-4 h-4" />
              {t('layout.logout')}
            </button>

            <div className="-mx-6 mt-4 border-t border-slate-700" />
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              {clusterStatus === 'checking' ? (
                <>
                  <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
                  <span>{t('layout.clusterChecking')}</span>
                </>
              ) : clusterStatus === 'connected' ? (
                <>
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span>{t('layout.clusterConnected')}</span>
                </>
              ) : (
                <>
                  <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                  <span>{t('layout.clusterDisconnected')}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="pl-64">
        <main className={`min-h-screen ${location.pathname === '/ai-chat' ? '' : 'p-8'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
