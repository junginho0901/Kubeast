/**
 * 라우트 경로 → 페이지 컨텍스트 메타 매핑.
 *
 * App.tsx 의 Route 정의를 전수 확인해 정적 맵 + 동적 매처 2단 구조로 구성.
 * 정적 맵에서 hit 하면 즉시 반환, 그 외는 동적 매처로 path param 추출.
 */

export interface RouteContextMeta {
  pageType: string
  /**
   * 화면 표시용 페이지 제목.
   * - `titleKey` 가 있으면 PageContextProvider 가 `t(titleKey, { defaultValue: pageTitle })` 로 변환
   * - 없으면 그대로 사용 (한국어 fallback)
   */
  pageTitle: string
  /** i18n 키 (있으면 우선) */
  titleKey?: string
  path: string
  resourceKind?: string
  namespace?: string
  resourceName?: string
}

type StaticEntry = {
  pageType: string
  pageTitle: string  // 한국어 기본 (legacy fallback)
  titleKey?: string
  resourceKind?: string
}

// App.tsx 기준 정적 경로 매핑
const STATIC_MAP: Record<string, StaticEntry> = {
  '/':                                    { pageType: 'dashboard',     titleKey: 'nav.dashboard',         pageTitle: '대시보드' },
  '/namespaces':                          { pageType: 'resource-list', resourceKind: 'Namespace',       titleKey: 'nav.namespaces',        pageTitle: '네임스페이스' },
  '/cluster/namespaces':                  { pageType: 'resource-list', resourceKind: 'Namespace',       titleKey: 'nav.namespaces',        pageTitle: '네임스페이스' },
  '/cluster/nodes':                       { pageType: 'resource-list', resourceKind: 'Node',            titleKey: 'nav.nodes',             pageTitle: '노드' },
  '/cluster/search':                      { pageType: 'search',                                         titleKey: 'nav.advancedSearch',    pageTitle: '고급 검색' },
  '/cluster/dependency-graph':            { pageType: 'graph',                                          titleKey: 'nav.dependencyGraph',   pageTitle: '의존성 그래프' },
  '/cluster/resource-graph':              { pageType: 'graph',                                          titleKey: 'nav.resourceGraph',     pageTitle: '리소스 그래프' },
  '/timeline':                            { pageType: 'timeline',                                       titleKey: 'nav.timeline',          pageTitle: '변경 이력' },

  '/workloads/pods':                      { pageType: 'resource-list', resourceKind: 'Pod',             titleKey: 'nav.pods',              pageTitle: '파드' },
  '/workloads/deployments':               { pageType: 'resource-list', resourceKind: 'Deployment',      titleKey: 'nav.deployments',       pageTitle: '디플로이먼트' },
  '/workloads/statefulsets':              { pageType: 'resource-list', resourceKind: 'StatefulSet',     titleKey: 'nav.statefulSets',      pageTitle: '스테이트풀셋' },
  '/workloads/daemonsets':                { pageType: 'resource-list', resourceKind: 'DaemonSet',       titleKey: 'nav.daemonSets',        pageTitle: '데몬셋' },
  '/workloads/replicasets':               { pageType: 'resource-list', resourceKind: 'ReplicaSet',      titleKey: 'nav.replicaSets',       pageTitle: '레플리카셋' },
  '/workloads/jobs':                      { pageType: 'resource-list', resourceKind: 'Job',             titleKey: 'nav.jobs',              pageTitle: '잡' },
  '/workloads/cronjobs':                  { pageType: 'resource-list', resourceKind: 'CronJob',         titleKey: 'nav.cronJobs',          pageTitle: '크론잡' },
  '/workloads/hpas':                      { pageType: 'resource-list', resourceKind: 'HorizontalPodAutoscaler', titleKey: 'nav.hpas', pageTitle: '수평 파드 오토스케일러' },
  '/workloads/vpas':                      { pageType: 'resource-list', resourceKind: 'VerticalPodAutoscaler',   titleKey: 'nav.vpas', pageTitle: '수직 파드 오토스케일러' },
  '/workloads/pdbs':                      { pageType: 'resource-list', resourceKind: 'PodDisruptionBudget',     titleKey: 'nav.pdbs', pageTitle: '파드 디스럽션 버짓' },

  '/storage':                             { pageType: 'resource-list',                                  titleKey: 'nav.storage',           pageTitle: '스토리지' },

  '/network/services':                    { pageType: 'resource-list', resourceKind: 'Service',         titleKey: 'nav.services',          pageTitle: '서비스' },
  '/network/endpoints':                   { pageType: 'resource-list', resourceKind: 'Endpoints',       titleKey: 'nav.endpoints',         pageTitle: '엔드포인트' },
  '/network/endpointslices':              { pageType: 'resource-list', resourceKind: 'EndpointSlice',   titleKey: 'nav.endpointSlices',    pageTitle: '엔드포인트 슬라이스' },
  '/network/ingresses':                   { pageType: 'resource-list', resourceKind: 'Ingress',         titleKey: 'nav.ingresses',         pageTitle: '인그레스' },
  '/network/ingressclasses':              { pageType: 'resource-list', resourceKind: 'IngressClass',    titleKey: 'nav.ingressClasses',    pageTitle: '인그레스 클래스' },
  '/network/networkpolicies':             { pageType: 'resource-list', resourceKind: 'NetworkPolicy',   titleKey: 'nav.networkPolicies',   pageTitle: '네트워크 폴리시' },

  '/gateway/gateways':                    { pageType: 'resource-list', resourceKind: 'Gateway',              titleKey: 'nav.gateways',                pageTitle: '게이트웨이' },
  '/gateway/gatewayclasses':              { pageType: 'resource-list', resourceKind: 'GatewayClass',         titleKey: 'nav.gatewayClasses',          pageTitle: '게이트웨이 클래스' },
  '/gateway/httproutes':                  { pageType: 'resource-list', resourceKind: 'HTTPRoute',            titleKey: 'nav.httpRoutes',              pageTitle: 'HTTP 라우트' },
  '/gateway/grpcroutes':                  { pageType: 'resource-list', resourceKind: 'GRPCRoute',            titleKey: 'nav.grpcRoutes',              pageTitle: 'GRPC 라우트' },
  '/gateway/referencegrants':             { pageType: 'resource-list', resourceKind: 'ReferenceGrant',       titleKey: 'nav.referenceGrants',         pageTitle: '레퍼런스 그랜트' },
  '/gateway/backendtlspolicies':          { pageType: 'resource-list', resourceKind: 'BackendTLSPolicy',     titleKey: 'nav.backendTlsPolicies',      pageTitle: '백엔드 TLS 폴리시' },
  '/gateway/backendtrafficpolicies':      { pageType: 'resource-list', resourceKind: 'BackendTrafficPolicy', titleKey: 'nav.backendTrafficPolicies',  pageTitle: '백엔드 트래픽 폴리시' },

  '/gpu/dashboard':                       { pageType: 'gpu',                                            titleKey: 'nav.gpuDashboard',           pageTitle: 'GPU 대시보드' },
  '/gpu/nodes':                           { pageType: 'gpu',           resourceKind: 'Node',            titleKey: 'nav.gpuNodes',               pageTitle: 'GPU 노드' },
  '/gpu/pods':                            { pageType: 'gpu',           resourceKind: 'Pod',             titleKey: 'nav.gpuPods',                pageTitle: 'GPU 파드' },
  '/gpu/deviceclasses':                   { pageType: 'resource-list', resourceKind: 'DeviceClass',             titleKey: 'nav.deviceClasses',          pageTitle: '디바이스 클래스' },
  '/gpu/resourceclaims':                  { pageType: 'resource-list', resourceKind: 'ResourceClaim',           titleKey: 'nav.resourceClaims',         pageTitle: '리소스 클레임' },
  '/gpu/resourceclaimtemplates':          { pageType: 'resource-list', resourceKind: 'ResourceClaimTemplate',   titleKey: 'nav.resourceClaimTemplates', pageTitle: '리소스 클레임 템플릿' },
  '/gpu/resourceslices':                  { pageType: 'resource-list', resourceKind: 'ResourceSlice',           titleKey: 'nav.resourceSlices',         pageTitle: '리소스 슬라이스' },

  '/security/serviceaccounts':            { pageType: 'resource-list', resourceKind: 'ServiceAccount',          titleKey: 'nav.serviceAccounts',         pageTitle: '서비스 어카운트' },
  '/security/roles':                      { pageType: 'resource-list', resourceKind: 'Role',                    titleKey: 'nav.roles',                   pageTitle: '롤' },
  '/security/clusterroles':               { pageType: 'resource-list', resourceKind: 'ClusterRole',             titleKey: 'nav.clusterRoles',            pageTitle: '클러스터 롤' },
  '/security/rolebindings':               { pageType: 'resource-list', resourceKind: 'RoleBinding',             titleKey: 'nav.roleBindings',            pageTitle: '롤 바인딩' },
  '/security/clusterrolebindings':        { pageType: 'resource-list', resourceKind: 'ClusterRoleBinding',      titleKey: 'nav.clusterRoleBindings',     pageTitle: '클러스터 롤 바인딩' },

  '/configuration/configmaps':            { pageType: 'resource-list', resourceKind: 'ConfigMap',               titleKey: 'nav.configMaps',              pageTitle: '컨피그맵' },
  '/configuration/secrets':               { pageType: 'resource-list', resourceKind: 'Secret',                  titleKey: 'nav.secrets',                 pageTitle: '시크릿' },

  '/cluster/resourcequotas':              { pageType: 'resource-list', resourceKind: 'ResourceQuota',                 titleKey: 'nav.resourceQuotas',          pageTitle: '리소스 쿼터' },
  '/cluster/limitranges':                 { pageType: 'resource-list', resourceKind: 'LimitRange',                    titleKey: 'nav.limitRanges',             pageTitle: '리밋 레인지' },
  '/cluster/priorityclasses':             { pageType: 'resource-list', resourceKind: 'PriorityClass',                 titleKey: 'nav.priorityClasses',         pageTitle: '우선순위 클래스' },
  '/cluster/runtimeclasses':              { pageType: 'resource-list', resourceKind: 'RuntimeClass',                  titleKey: 'nav.runtimeClasses',          pageTitle: '런타임 클래스' },
  '/cluster/leases':                      { pageType: 'resource-list', resourceKind: 'Lease',                         titleKey: 'nav.leases',                  pageTitle: '리스' },
  '/cluster/mutatingwebhookconfigurations':   { pageType: 'resource-list', resourceKind: 'MutatingWebhookConfiguration',   titleKey: 'nav.mutatingWebhooks',     pageTitle: '변경 웹훅 구성' },
  '/cluster/validatingwebhookconfigurations': { pageType: 'resource-list', resourceKind: 'ValidatingWebhookConfiguration', titleKey: 'nav.validatingWebhooks',   pageTitle: '검증 웹훅 구성' },

  '/custom-resources/instances':          { pageType: 'resource-list', resourceKind: 'CustomResource',                titleKey: 'nav.customInstances',         pageTitle: '커스텀 리소스 인스턴스' },
  '/custom-resources/groups':             { pageType: 'resource-list', resourceKind: 'CustomResourceDefinition',      titleKey: 'nav.customGroups',            pageTitle: '커스텀 리소스 정의' },

  '/helm/releases':                       { pageType: 'helm-list',                                       titleKey: 'nav.helmReleases',            pageTitle: 'Releases' },

  '/monitoring':                          { pageType: 'monitoring',                                      titleKey: 'nav.monitoring',              pageTitle: '리소스 모니터링' },
  '/cluster-view':                        { pageType: 'cluster-view',                                    titleKey: 'nav.clusterView',             pageTitle: '클러스터 뷰' },
  '/ai-chat':                             { pageType: 'ai-chat',                                         titleKey: 'nav.aiChat',                  pageTitle: 'AI 챗' },
  '/account':                             { pageType: 'account',                                         titleKey: 'layout.account',              pageTitle: '설정' },
}

// 동적 경로 매처 (path param 포함)
const DYNAMIC_PATTERNS: Array<
  [RegExp, (m: RegExpMatchArray) => Omit<RouteContextMeta, 'path'>]
> = [
  [
    /^\/topology\/([^/]+)$/,
    (m) => ({ pageType: 'topology', pageTitle: `토폴로지 · ${m[1]}`, namespace: m[1] }),
  ],
  [
    /^\/resources\/([^/]+)$/,
    (m) => ({ pageType: 'resource-list', pageTitle: `리소스 · ${m[1]}`, namespace: m[1] }),
  ],
  [
    /^\/helm\/releases\/([^/]+)\/([^/]+)$/,
    (m) => ({
      pageType: 'resource-detail',
      resourceKind: 'HelmRelease',
      namespace: m[1],
      resourceName: m[2],
      pageTitle: `Helm · ${m[2]}`,
    }),
  ],
  // /network/:namespace — 정적 /network/services 등보다 뒤에 매칭 (정적 우선)
  [
    /^\/network\/([^/]+)$/,
    (m) => ({ pageType: 'network', pageTitle: `네트워크 · ${m[1]}`, namespace: m[1] }),
  ],
  [
    /^\/admin\/[a-z-]+$/,
    () => ({ pageType: 'admin', pageTitle: '관리' }),
  ],
]

export function resolveRouteMeta(pathname: string): RouteContextMeta {
  const hit = STATIC_MAP[pathname]
  if (hit) return { ...hit, path: pathname }

  for (const [re, build] of DYNAMIC_PATTERNS) {
    const m = pathname.match(re)
    if (m) return { ...build(m), path: pathname }
  }

  return { pageType: 'other', pageTitle: '', path: pathname }
}
