import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useMemo, useState, useEffect, Suspense, type ComponentType } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Bot,
  Building2,
  ChartColumn,
  ClipboardCheck,
  Cloud,
  FileSearch,
  Film,
  Gauge,
  History,
  Hourglass,
  IdCard,
  Layers,
  LayoutDashboard,
  LogOut,
  MemoryStick,
  MessageSquare,
  Microchip,
  ScrollText,
  Search,
  ShieldCheck,
  SquareTerminal,
  Users,
  Waypoints,
} from 'lucide-react'
import { KIND_ICONS as K } from './kindIcons'
import { api } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import { logoutSession } from '@/services/auth'
import ForbiddenBanner from './ForbiddenBanner'
import AccessHelp from './AccessHelp'
import { ResourceDetailProvider } from './ResourceDetailProvider'
import ResourceDetailDrawer from './LazyResourceDetailDrawer'
import PendingApproval from './PendingApproval'
import { PageContextProvider } from './PageContextProvider'
import FloatingAIChat from './FloatingAIChat'
import { BetaTag } from './BetaTag'
import ClusterPicker from './ClusterPicker'
import ClusterSwitchProgress from './ClusterSwitchProgress'
import RouteFallback from './RouteFallback'
import { useCluster } from '../contexts/ClusterContext'
import { usePermission } from '@/hooks/usePermission'
import { resolveRouteMeta } from '@/utils/aiContext/routeMatcher'

type NavItem = {
  name: string
  href: string
  icon?: ComponentType<{ className?: string }>
  exact?: boolean
  match?: (pathname: string, search: string) => boolean
  // A count shown after the name (pending access requests).
  badge?: number
  // A small label after the name (Beta).
  tag?: string
  testId?: string
}

type NavGroup = {
  id: string
  label: string
  // A small label after the name (Beta), as on items.
  tag?: string
  items: NavItem[]
  adminOnly?: boolean
  // requiredPermission hides the entire group when the user lacks the
  // permission. Existing groups do not use it (they rely on adminOnly
  // or show for everyone); it is introduced for Helm which is the
  // first group gated by a non-admin menu permission.
  requiredPermission?: string
}

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentCluster } = useCluster()
  const queryClient = useQueryClient()
  const [clusterStatus, setClusterStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking')

  const {
    data: me,
    isLoading: isMeLoading,
    isError: isMeError,
  } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: 1,
    staleTime: 30000,
  })

  // The clusters this user can actually reach. A non-admin with no grants has
  // none — we then show a "no accessible cluster" placeholder instead of the
  // resource pages, so the pages never mount and never fire cluster requests
  // that would all 403 (deny-by-default).
  const { data: accessibleClusters = [], isLoading: isClustersLoading } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
  })

  // The nav scrolls on short viewports: keep the current page's entry in view
  // (deep links into the ADMIN section land below the fold otherwise). The
  // entry's group opens with a 200 ms transition and the account box under the
  // nav renders once `me` resolves, both after this runs — so it scrolls again
  // whenever the nav changes size during the first second after a page change
  // (later on, the user's own scrolling wins).
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="sidebar-nav"]')
    const scroll = () =>
      nav?.querySelector<HTMLElement>(`a[href="${CSS.escape(location.pathname)}"]`)?.scrollIntoView({ block: 'nearest' })
    scroll()
    if (!nav || typeof ResizeObserver === 'undefined') return
    const until = Date.now() + 1000
    const observer = new ResizeObserver(() => {
      if (Date.now() < until) scroll()
    })
    observer.observe(nav)
    for (const child of Array.from(nav.children)) observer.observe(child)
    const timer = window.setTimeout(scroll, 300)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [location.pathname, isMeLoading])

  useEffect(() => {
    if (!isMeError) return
    queryClient.clear()
    navigate('/login')
  }, [isMeError, navigate, queryClient])

  useEffect(() => {
    const checkClusterStatus = async () => {
      try {
        const health = await api.getHealth()
        setClusterStatus(health.kubernetes === 'connected' ? 'connected' : 'disconnected')
      } catch {
        setClusterStatus('disconnected')
      }
    }

    checkClusterStatus()
    const interval = setInterval(checkClusterStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleLogout = () => {
    // The session is the HttpOnly cookie; the logout response clears it.
    void logoutSession()
    queryClient.clear()
    navigate('/login')
  }

  const { t } = useTranslation()
  // Menu/permission gating uses the JWT per-cluster matrix (what the backend
  // actually enforces) scoped to the SELECTED cluster — not the global role's
  // flat list, which would show menus/actions the backend then 403s for a user
  // whose access is granted per-cluster. has(perm) defaults to the current
  // cluster, so the menus reflect what you can actually do on the cluster you're
  // viewing.
  const { has: hasPermission, permissions: matrix } = usePermission()
  // The admin section requires a GLOBAL admin permission, which lives only in
  // the matrix "*" entry — per-cluster grants never carry admin.*.
  const isAdmin = (matrix['*'] ?? []).some((p) => p === '*' || p.startsWith('admin.'))
  // A non-admin with zero accessible clusters can't view any resource page;
  // the account page (profile, language, sign-out) needs no cluster.
  const hasNoCluster = !isAdmin && !isClustersLoading && accessibleClusters.length === 0
  const noAccessibleCluster = hasNoCluster && location.pathname !== '/account'
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ core: true })

  // Access requests (temporary role grants): the admin menu item appears only
  // when the installation has them on, with the number waiting for a decision.
  const { data: accessRequestsConfig } = useQuery({
    queryKey: ['access-requests', 'config'],
    queryFn: api.getAccessRequestsConfig,
    staleTime: 60_000,
    retry: false,
  })
  const accessRequestsOn = !!accessRequestsConfig?.enabled
  const { data: pendingAccessRequests = [] } = useQuery({
    queryKey: ['access-requests', 'admin', 'pending'],
    queryFn: () => api.adminListAccessRequests('pending'),
    enabled: isAdmin && accessRequestsOn,
    refetchInterval: 60_000,
    retry: false,
  })
  const pendingAccessCount = pendingAccessRequests.length
  // Access review: the admin menu item appears only when the installation has it on.
  const { data: accessReviewConfig } = useQuery({
    queryKey: ['access-review', 'config'],
    queryFn: api.getAccessReviewConfig,
    staleTime: 60_000,
    retry: false,
    enabled: isAdmin,
  })
  const accessReviewOn = !!accessReviewConfig?.enabled
  // Cluster hygiene: shown to admins who can read it, when the installation has it on.
  const canReadHygiene = isAdmin && hasPermission('admin.hygiene.read')
  const { data: hygieneConfig } = useQuery({
    queryKey: ['hygiene', 'config'],
    queryFn: api.getHygieneConfig,
    staleTime: 60_000,
    retry: false,
    enabled: canReadHygiene,
  })
  const hygieneOn = canReadHygiene && !!hygieneConfig?.enabled

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
        { name: t('nav.resourceGraph'), href: '/cluster/resource-graph', icon: Waypoints },
        { name: t('nav.timeline'), href: '/timeline', icon: History },
      ],
    },
    {
      id: 'cluster',
      label: t('nav.cluster'),
      items: [
        { name: t('nav.namespaces'), href: '/cluster/namespaces', icon: K.Namespace },
        { name: t('nav.nodes'), href: '/cluster/nodes', icon: K.Node },
        { name: t('nav.advancedSearch'), href: '/cluster/search', icon: Search, tag: t('common.beta') },
        { name: t('nav.priorityClasses'), href: '/cluster/priorityclasses', icon: K.PriorityClass },
        { name: t('nav.runtimeClasses'), href: '/cluster/runtimeclasses', icon: K.RuntimeClass },
        { name: t('nav.leases'), href: '/cluster/leases', icon: K.Lease },
        { name: t('nav.resourceQuotas'), href: '/cluster/resourcequotas', icon: K.ResourceQuota },
        { name: t('nav.limitRanges'), href: '/cluster/limitranges', icon: K.LimitRange },
        { name: t('nav.mutatingWebhooks'), href: '/cluster/mutatingwebhookconfigurations', icon: K.MutatingWebhookConfiguration },
        { name: t('nav.validatingWebhooks'), href: '/cluster/validatingwebhookconfigurations', icon: K.ValidatingWebhookConfiguration },
      ],
    },
    {
      id: 'workloads',
      label: t('nav.workloads'),
      items: [
        { name: t('nav.pods'), href: '/workloads/pods', icon: K.Pod },
        { name: t('nav.deployments'), href: '/workloads/deployments', icon: K.Deployment },
        { name: t('nav.statefulSets'), href: '/workloads/statefulsets', icon: K.StatefulSet },
        { name: t('nav.daemonSets'), href: '/workloads/daemonsets', icon: K.DaemonSet },
        { name: t('nav.replicaSets'), href: '/workloads/replicasets', icon: K.ReplicaSet },
        { name: t('nav.jobs'), href: '/workloads/jobs', icon: K.Job },
        { name: t('nav.cronJobs'), href: '/workloads/cronjobs', icon: K.CronJob },
        { name: t('nav.hpas'), href: '/workloads/hpas', icon: K.HorizontalPodAutoscaler },
        { name: t('nav.vpas'), href: '/workloads/vpas', icon: K.VerticalPodAutoscaler },
        { name: t('nav.pdbs'), href: '/workloads/pdbs', icon: K.PodDisruptionBudget },
      ],
    },
    {
      id: 'storage',
      label: t('nav.storage'),
      items: [
        {
          name: t('nav.pvcs'),
          href: '/storage?tab=pvcs',
          icon: K.PersistentVolumeClaim,
          match: (pathname, search) => storageTabMatch('pvcs', pathname, search),
        },
        {
          name: t('nav.pvs'),
          href: '/storage?tab=pvs',
          icon: K.PersistentVolume,
          match: (pathname, search) => storageTabMatch('pvs', pathname, search),
        },
        {
          name: t('nav.storageClasses'),
          href: '/storage?tab=storageclasses',
          icon: K.StorageClass,
          match: (pathname, search) => storageTabMatch('storageclasses', pathname, search),
        },
        {
          name: t('nav.volumeAttachments'),
          href: '/storage?tab=volumeattachments',
          icon: K.VolumeAttachment,
          match: (pathname, search) => storageTabMatch('volumeattachments', pathname, search),
        },
      ],
    },
    {
      id: 'network',
      label: t('nav.network'),
      items: [
        { name: t('nav.services'), href: '/network/services', icon: K.Service },
        { name: t('nav.endpoints'), href: '/network/endpoints', icon: K.Endpoints },
        { name: t('nav.endpointSlices'), href: '/network/endpointslices', icon: K.EndpointSlice },
        { name: t('nav.ingresses'), href: '/network/ingresses', icon: K.Ingress },
        { name: t('nav.ingressClasses'), href: '/network/ingressclasses', icon: K.IngressClass },
        { name: t('nav.networkPolicies'), href: '/network/networkpolicies', icon: K.NetworkPolicy },
      ],
    },
    {
      id: 'gateway',
      label: t('nav.gateway'),
      tag: t('common.beta'),
      items: [
        { name: t('nav.gateways'), href: '/gateway/gateways', icon: K.Gateway },
        { name: t('nav.gatewayClasses'), href: '/gateway/gatewayclasses', icon: K.GatewayClass },
        { name: t('nav.httpRoutes'), href: '/gateway/httproutes', icon: K.HTTPRoute },
        { name: t('nav.grpcRoutes'), href: '/gateway/grpcroutes', icon: K.GRPCRoute },
        { name: t('nav.referenceGrants'), href: '/gateway/referencegrants', icon: K.ReferenceGrant },
        { name: t('nav.backendTlsPolicies'), href: '/gateway/backendtlspolicies', icon: K.BackendTLSPolicy },
        { name: t('nav.policies'), href: '/gateway/policies', icon: ScrollText },
      ],
    },
    {
      id: 'gpu',
      label: t('nav.gpu'),
      tag: t('common.beta'),
      items: [
        { name: t('nav.gpuDashboard'), href: '/gpu/dashboard', icon: Gauge },
        { name: t('nav.gpuNodes'), href: '/gpu/nodes', icon: MemoryStick },
        { name: t('nav.gpuPods'), href: '/gpu/pods', icon: Microchip },
        { name: t('nav.deviceClasses'), href: '/gpu/deviceclasses', icon: K.DeviceClass },
        { name: t('nav.resourceClaims'), href: '/gpu/resourceclaims', icon: K.ResourceClaim },
        { name: t('nav.resourceClaimTemplates'), href: '/gpu/resourceclaimtemplates', icon: K.ResourceClaimTemplate },
        { name: t('nav.resourceSlices'), href: '/gpu/resourceslices', icon: K.ResourceSlice },
      ],
    },
    {
      id: 'security',
      label: t('nav.security'),
      items: [
        { name: t('nav.serviceAccounts'), href: '/security/serviceaccounts', icon: K.ServiceAccount },
        { name: t('nav.roles'), href: '/security/roles', icon: K.Role },
        { name: t('nav.clusterRoles'), href: '/security/clusterroles', icon: K.ClusterRole },
        { name: t('nav.roleBindings'), href: '/security/rolebindings', icon: K.RoleBinding },
        { name: t('nav.clusterRoleBindings'), href: '/security/clusterrolebindings', icon: K.ClusterRoleBinding },
      ],
    },
    {
      id: 'configuration',
      label: t('nav.configuration'),
      items: [
        { name: t('nav.configMaps'), href: '/configuration/configmaps', icon: K.ConfigMap },
        { name: t('nav.secrets'), href: '/configuration/secrets', icon: K.Secret },
      ],
    },
    {
      id: 'helm',
      label: t('nav.helm'),
      requiredPermission: 'menu.helm',
      items: [
        { name: t('nav.helmReleases'), href: '/helm/releases', icon: K.HelmRelease },
      ],
    },
    {
      id: 'customResources',
      label: t('nav.customResources'),
      items: [
        { name: t('nav.customInstances'), href: '/custom-resources/instances', icon: K.CustomResourceInstance },
        { name: t('nav.customGroups'), href: '/custom-resources/groups', icon: K.CustomResourceDefinition },
      ],
    },
    {
      id: 'admin',
      label: t('nav.admin'),
      adminOnly: true,
      items: [
        { name: t('nav.clusters', { defaultValue: 'Clusters' }), href: '/admin/clusters', icon: Cloud },
        { name: t('nav.userManagement'), href: '/admin/users', icon: Users },
        { name: t('nav.roleManagement'), href: '/admin/roles', icon: IdCard },
        ...(accessRequestsOn
          ? [{ name: t('nav.accessRequests', { defaultValue: 'Access Requests' }), href: '/admin/access-requests', icon: Hourglass, badge: pendingAccessCount, testId: 'nav-access-requests' }]
          : []),
        ...(accessReviewOn
          ? [{ name: t('nav.accessReview', { defaultValue: 'Access Review' }), href: '/admin/access-review', icon: ClipboardCheck, testId: 'nav-access-review' }]
          : []),
        ...(hygieneOn
          ? [{ name: t('nav.clusterHygiene', { defaultValue: 'Cluster Hygiene' }), href: '/admin/cluster-hygiene', icon: ShieldCheck, testId: 'nav-cluster-hygiene' }]
          : []),
        { name: t('nav.organizations'), href: '/admin/organizations', icon: Building2 },
        { name: t('nav.aiModels'), href: '/admin/ai-models', icon: Bot },
        { name: t('nav.auditLogs'), href: '/admin/audit', icon: FileSearch },
        { name: t('nav.sessionRecordings', { defaultValue: 'Session Recordings' }), href: '/admin/session-recordings', icon: Film, testId: 'nav-session-recordings' },
        { name: t('nav.aiUsage'), href: '/admin/ai-usage', icon: ChartColumn },
        { name: t('nav.nodeShell'), href: '/admin/node-shell', icon: SquareTerminal },
      ],
    },
  ], [t, accessRequestsOn, pendingAccessCount, accessReviewOn, hygieneOn])

  const active = useMemo(() => {
    for (const group of navGroups) {
      if (group.adminOnly && !isAdmin) continue
      if (group.requiredPermission && !hasPermission(group.requiredPermission)) continue
      for (const item of group.items) {
        const isActive = item.match
          ? item.match(location.pathname, location.search)
          : item.exact
            ? location.pathname === item.href
            : location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)
        if (isActive) return { group: group.id, name: item.name }
      }
    }
    return null
  }, [isAdmin, location.pathname, location.search, navGroups, hasPermission])
  const activeGroup = active?.group ?? null

  // Browser tab: "<screen> · Kubeast" (WCAG 2.4.2 Page Titled) — the sidebar's name for the page, or the route's
  // screen name for pages the sidebar does not list (Settings, a Helm release).
  useEffect(() => {
    const meta = resolveRouteMeta(location.pathname)
    const name = active?.name ?? (meta.titleKey ? t(meta.titleKey) : '')
    document.title = name ? `${name} · Kubeast` : 'Kubeast'
  }, [active, location.pathname, t])

  useEffect(() => {
    if (!activeGroup) return
    setOpenGroups({ [activeGroup]: true })
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

  if (isMeLoading || !me) {
    return <div className="min-h-screen bg-slate-900" />
  }

  // Approved = a non-Pending global role. A Member with no per-cluster grants is
  // still approved (they just see "no accessible cluster" until granted), so the
  // gate is the account state, not menu visibility (which is now per-cluster).
  if (!me.role || me.role.name === 'Pending') {
    return <PendingApproval />
  }

  return (
    <ResourceDetailProvider>
    <PageContextProvider>
    <div className="min-h-screen bg-slate-900">
      <ResourceDetailDrawer />
      <FloatingAIChat />
      <div className="fixed inset-y-0 left-0 w-64 bg-slate-800 border-r border-slate-700">
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-6 border-b border-slate-700 h-[100px]">
            <Activity className="w-8 h-8 text-primary-500" />
            <div>
              {/* not an <h1>: the page title is the one heading of each screen */}
              <p className="text-xl font-bold text-white">Kubeast</p>
              <p className="text-xs text-slate-400">K8s DevOps Platform</p>
            </div>
          </div>

          <ClusterPicker />

          {/* min-h-0: a flex child defaults to min-height:auto, so without it the nav grows
              past the sidebar and the ADMIN items end up under the account box */}
          <nav data-testid="sidebar-nav" className="sidebar-nav flex-1 min-h-0 px-4 py-6 space-y-2 overflow-y-auto">
            {navGroups
              .filter((group) => {
                if (group.adminOnly && !isAdmin) return false
                if (group.requiredPermission && !hasPermission(group.requiredPermission)) return false
                return true
              })
              .map((group) => (
                <div key={group.label} className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className={`relative w-full flex items-center px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] transition-colors ${
                      openGroups[group.id]
                        ? "text-white before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-full before:bg-primary-500/80"
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>{group.label}</span>
                    {group.tag && <span className="ml-2 normal-case tracking-normal"><BetaTag label={group.tag} /></span>}
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
                            data-testid={item.testId}
                            title={item.name}
                            className={`
                              flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors
                              ${isActive ? 'bg-primary-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}
                            `}
                          >
                            {/* shrink-0: a long name squeezed the icon; truncate: the long kind names ran out of the bar */}
                            {Icon && <Icon className="w-4 h-4 shrink-0" />}
                            <span className="min-w-0 truncate font-medium">{item.name}</span>
                            {item.tag && <BetaTag label={item.tag} />}
                            {item.badge ? (
                              <span
                                className="ml-auto rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-slate-900"
                                data-testid={item.testId ? `${item.testId}-badge` : undefined}
                              >
                                {item.badge}
                              </span>
                            ) : null}
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
              className="block rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 hover:bg-slate-700/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600"
              title={t('layout.accountTitle')}
            >
              <div className="text-[11px] text-slate-400">{t('layout.account')}</div>
              <div className="mt-0.5 truncate text-sm text-white">{me?.name ?? '...'}</div>
              {me?.email && me.email !== me.name && <div className="truncate text-xs text-slate-400">{me.email}</div>}
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
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-400" data-testid="cluster-status">
              {hasNoCluster ? (
                <>
                  <div className="w-2 h-2 bg-slate-500 rounded-full"></div>
                  <span>{t('layout.noAccessibleCluster', { defaultValue: 'No accessible cluster' })}</span>
                </>
              ) : clusterStatus === 'checking' ? (
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
        <ClusterSwitchProgress />
        <main className={`min-h-screen ${location.pathname === '/ai-chat' ? '' : 'p-8'}`}>
          {/* Remount page content on cluster switch so cluster-specific local UI
              state (selected namespace, filters, open modals) never carries over
              to a different cluster — its namespaces/resources differ. */}
          <div key={currentCluster || 'default'} className="contents">
            <ForbiddenBanner clusterKey={currentCluster || 'default'} />
            {noAccessibleCluster ? (
              <div
                data-testid="no-accessible-cluster"
                className="flex min-h-[60vh] flex-col items-center justify-center text-center px-6"
              >
                <div className="rounded-full bg-slate-800 border border-slate-700 p-4 mb-4">
                  <Activity className="w-8 h-8 text-slate-500" />
                </div>
                <h2 className="text-lg font-semibold text-white">
                  {t('cluster.noAccess.title', { defaultValue: 'No accessible cluster' })}
                </h2>
                <p className="mt-1 max-w-md text-sm text-slate-400">
                  {t('cluster.noAccess.body', {
                    defaultValue:
                      'You have not been granted access to any cluster yet. Ask an administrator to grant you a role on a cluster.',
                  })}
                </p>
                <AccessHelp className="mt-3 max-w-md text-sm" />
              </div>
            ) : !isAdmin && isClustersLoading ? (
              // Until the accessible-cluster list is known, a non-admin's
              // page would mount and fire cluster requests that all 403.
              <RouteFallback />
            ) : (
              <Suspense fallback={<RouteFallback />}>
                <Outlet />
              </Suspense>
            )}
          </div>
        </main>
      </div>
    </div>
    </PageContextProvider>
    </ResourceDetailProvider>
  )
}
