(() => {
  'use strict';
  // Integrations: one box. Category buttons above, a wall of same-size tiles under them (every tool under All), one
  // note under the wall for the tool picked, and the standard paths as lines of words, naming no product. A category
  // hides the tools of the others. The same tool again or Escape closes the note.
  //
  // DATA is the one list to change. categories: [key, English, Korean], in the order of the buttons. via: how a tool
  // connects, in both languages. items, in the order of the wall: id, cat (a category key), name (and name_ko when the
  // Korean differs, tm for a ® or ™ mark), logo (a file of official-icons/; `shown` when a file drawn dark, of an
  // owner with no light version, is shown on the dark page as `reversed` colours or one `white` colour) or text
  // (words in place of a logo), `line: true` for a standard path shown as a line of words, via, home (the tool's own
  // page), doc ([file under docs/, anchor of the English doc, anchor of the Korean doc]) and en / ko (what Kubeast does
  // with it; `backticks` are code). `off: true` keeps an entry out of the box; taking it out brings the entry back.
  // `tested` says whether the entry was run against the real product; the page does not show it.
  // The docs links go to the tag the section names in data-docs-tag.
  const DATA = /* DATA */ {
    "categories": [
      ["all", "All", "전체"],
      ["signin", "Sign-in", "로그인"],
      ["ai", "AI models & agents", "AI 모델·에이전트"],
      ["observe", "Metrics, logs & traces", "지표·로그·트레이스"],
      ["alerts", "Alerts & notifications", "알림·전송"],
      ["network", "Network", "네트워크"],
      ["cluster", "Cluster tools", "클러스터 도구"],
      ["platform", "Storage & install", "저장·설치"]
    ],
    "via": {
      "oidc": {"en": "Standard OpenID Connect, one provider at a time (chart values `auth.oidc`)", "ko": "표준 OpenID Connect, 한 번에 공급자 하나(차트 값 `auth.oidc`)"},
      "provider": {"en": "A provider of its own under Admin > AI Models", "ko": "Admin > AI Models의 전용 공급자"},
      "mcp": {"en": "Model Context Protocol over Streamable HTTP, with a Kubeast API key", "ko": "Streamable HTTP의 Model Context Protocol, Kubeast API 키"},
      "prometheus-api": {"en": "Prometheus query API: found in the cluster, a Service you name, or a URL", "ko": "Prometheus 쿼리 API: 클러스터에서 찾거나, 지정한 Service나 주소"},
      "grafana-proxy": {"en": "Grafana's data source proxy, with a Viewer service account token", "ko": "Viewer 서비스 계정 토큰으로 Grafana 데이터 소스 프록시"},
      "k8s-api": {"en": "The cluster's API server, with the signed-in user's access", "ko": "클러스터 API 서버, 로그인한 사용자 권한"},
      "prometheus-metrics": {"en": "Its metrics in the cluster's Prometheus", "ko": "클러스터 Prometheus에 있는 그 지표"},
      "collector": {"en": "It sends data to the stores Kubeast reads; Kubeast does not talk to it", "ko": "Kubeast가 읽는 저장소로 데이터를 보냅니다. Kubeast는 직접 연결하지 않습니다"},
      "store-api": {"en": "The store's read API, at a URL or through Grafana", "ko": "저장소의 읽기 API, 주소나 Grafana를 거쳐"},
      "link": {"en": "A link the browser opens; Kubeast does not read it", "ko": "브라우저가 여는 링크. Kubeast는 읽지 않습니다"},
      "webhook-in": {"en": "It sends alerts to Kubeast's webhook; alerts and silences are read through its Alertmanager API", "ko": "Kubeast 웹훅으로 알림을 보내고, 알림·사일런스는 Alertmanager API로 읽습니다"},
      "sink": {"en": "An audit sink: Kubeast sends copies of the records you pick", "ko": "감사 싱크: 고른 기록의 사본을 Kubeast가 보냅니다"},
      "s3": {"en": "The S3 API: a bucket, its region and access keys", "ko": "S3 API: 버킷, 그 리전, 접근 키"},
      "s3-compatible": {"en": "The S3 API: the S3 sink, with an endpoint for a store other than Amazon S3", "ko": "S3 API: S3 싱크, Amazon S3가 아닌 저장소는 endpoint 지정"},
      "openai-compatible": {"en": "OpenAI-compatible API: Custom / Other under Admin > AI Models, with a base URL", "ko": "OpenAI 호환 API: Admin > AI Models의 Custom / Other에 기본 주소"},
      "aws-api": {"en": "The AWS API, with Kubeast's own AWS identity", "ko": "Kubeast 자신의 AWS 자격으로 AWS API"},
      "chart": {"en": "Objects the chart makes for it", "ko": "차트가 만드는 객체"},
      "database": {"en": "Kubeast's own database connection (`DATABASE_URL`)", "ko": "Kubeast 자체 데이터베이스 연결(`DATABASE_URL`)"},
      "bundled": {"en": "Part of the chart", "ko": "차트에 들어 있음"},
      "runs-on": {"en": "Where Kubeast runs", "ko": "Kubeast가 도는 곳"},
      "release": {"en": "Made by Kubeast's release workflow; you check it", "ko": "릴리스 워크플로가 만들고, 사용자가 확인합니다"}
    },
    "items": [
      {"id": "keycloak", "tested": true, "cat": "signin", "name": "Keycloak", "tm": "™", "logo": "keycloak.svg", "via": "oidc", "home": "https://www.keycloak.org/", "doc": ["oidc.md", "keycloak", "keycloak"], "en": "Sign in through a Keycloak realm with PKCE, and map its groups to account and cluster roles. Someone moved to another group gets the new role at the next sign-in.", "ko": "Keycloak realm으로 PKCE 로그인을 하고, 그룹을 계정·클러스터 역할에 연결합니다. 다른 그룹으로 옮긴 사람은 다음 로그인 때 새 역할을 받습니다."},
      {"id": "google", "tested": true, "cat": "signin", "name": "Google", "logo": "google.svg", "via": "oidc", "home": "https://developers.google.com/identity", "doc": ["oidc.md", "google", "google"], "en": "Sign in with the Google accounts of your Workspace domain. Google ID tokens carry no groups, so an admin grants the roles, or Kubeast reads each person's Workspace groups through the Admin SDK Directory API.", "ko": "Workspace 도메인의 Google 계정으로 로그인합니다. Google ID 토큰에는 그룹이 없어서 관리자가 역할을 주거나, Kubeast가 Admin SDK Directory API로 Workspace 그룹을 읽습니다."},
      {"id": "entra", "tested": false, "cat": "signin", "name": "Microsoft Entra ID", "logo": "entra-id.svg", "via": "oidc", "home": "https://www.microsoft.com/en-us/security/business/identity-access/microsoft-entra-id", "doc": ["oidc.md", "microsoft-entra-id", "microsoft-entra-id"], "en": "Sign in with an Entra ID app registration. Groups arrive as object IDs, so the role mapping names those IDs.", "ko": "Entra ID 앱 등록으로 로그인합니다. 그룹은 객체 ID로 오므로 역할 연결에 그 ID를 적습니다."},
      {"id": "okta", "tested": false, "cat": "signin", "name": "Okta", "logo": "okta.png", "via": "oidc", "home": "https://www.okta.com/", "doc": ["oidc.md", "okta", "okta"], "en": "Sign in with an Okta OIDC web application, with groups from its authorization server's claim.", "ko": "Okta OIDC 웹 애플리케이션으로 로그인하고, 그룹은 권한 서버의 클레임에서 받습니다."},
      {"id": "oidc-any", "tested": true, "cat": "signin", "line": true, "name": "Connect any standard OpenID Connect provider", "name_ko": "표준 OpenID Connect 공급자로 연결", "via": "oidc", "home": "https://openid.net/developers/how-connect-works/", "doc": ["oidc.md", "1-how-it-works", "1-동작"], "en": "Any OpenID Connect provider, through the authorization code flow with PKCE. The account is made at the first sign-in, and every sign-in, failed or not, goes to the audit log.", "ko": "PKCE 인가 코드 흐름으로 OpenID Connect 공급자를 연결합니다. 계정은 첫 로그인 때 만들어지고, 로그인은 성공과 실패 모두 감사 기록에 남습니다."},

      {"id": "openai", "tested": true, "cat": "ai", "name": "OpenAI", "logo": "openai.svg", "via": "provider", "home": "https://openai.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Chat and alert investigations with OpenAI models and your API key. The model list comes from the provider.", "ko": "API 키로 OpenAI 모델을 써서 채팅하고 알림을 조사합니다. 모델 목록은 공급자에게서 받습니다."},
      {"id": "anthropic", "tested": true, "cat": "ai", "name": "Anthropic", "logo": "anthropic.svg", "via": "provider", "home": "https://www.anthropic.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Claude models through Anthropic's Messages API, with your API key.", "ko": "API 키로 Anthropic Messages API를 거쳐 Claude 모델을 씁니다."},
      {"id": "gemini", "tested": true, "cat": "ai", "name": "Google Gemini", "logo": "gemini.svg", "via": "provider", "home": "https://ai.google.dev/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Chat and alert investigations with Gemini models and your API key.", "ko": "API 키로 Gemini 모델을 써서 채팅하고 알림을 조사합니다."},
      {"id": "azure-openai", "tested": false, "cat": "ai", "name": "Azure OpenAI", "logo": "azure-openai.svg", "via": "provider", "home": "https://azure.microsoft.com/en-us/products/ai-foundry/models/openai", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Azure OpenAI's v1 API: the resource's `/openai/v1/` address, with the deployment name as the model.", "ko": "Azure OpenAI의 v1 API를 씁니다. 리소스의 `/openai/v1/` 주소를 적고, 모델 칸에는 배포 이름을 적습니다."},
      {"id": "claude-sub", "off": true, "tested": true, "cat": "ai", "name": "Claude subscription", "name_ko": "Claude 구독", "logo": "claude.svg", "via": "provider", "home": "https://claude.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "For an install you use alone: chat with a Claude Pro or Max subscription's setup-token instead of an API key. Kubeast runs Claude Code for each model call, with the same tools, approval cards and audit records.", "ko": "혼자 쓰는 설치 전용입니다. API 키 대신 Claude Pro·Max 구독의 setup-token으로 채팅합니다. 모델을 부를 때마다 Claude Code를 실행하고, 도구·승인 카드·감사 기록은 같습니다."},
      {"id": "ollama", "tested": true, "cat": "ai", "name": "Ollama", "logo": "ollama.png", "shown": "reversed", "via": "provider", "home": "https://ollama.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Models you run yourself in Ollama. With an in-house model, the data stays in your network.", "ko": "Ollama에서 직접 운영하는 모델을 씁니다. 내부 모델이면 데이터가 네트워크 밖으로 나가지 않습니다."},
      {"id": "litellm", "tested": false, "cat": "ai", "name": "LiteLLM", "logo": "litellm.png", "via": "openai-compatible", "home": "https://www.litellm.ai/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "A LiteLLM gateway at its `/v1` address. The gateway answers only the model names it maps.", "ko": "LiteLLM 게이트웨이를 `/v1` 주소로 등록합니다. 게이트웨이는 연결해 둔 모델 이름에만 답합니다."},
      {"id": "groq", "tested": false, "cat": "ai", "name": "Groq", "logo": "groq-glyph.svg", "via": "openai-compatible", "home": "https://groq.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Groq's OpenAI-compatible API, base URL `https://api.groq.com/openai/v1`.", "ko": "Groq의 OpenAI 호환 API, 기본 주소 `https://api.groq.com/openai/v1`."},
      {"id": "deepseek", "tested": false, "cat": "ai", "name": "DeepSeek", "logo": "deepseek.svg", "via": "openai-compatible", "home": "https://www.deepseek.com/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "DeepSeek's OpenAI-compatible API, base URL `https://api.deepseek.com`.", "ko": "DeepSeek의 OpenAI 호환 API, 기본 주소 `https://api.deepseek.com`."},
      {"id": "mistral", "tested": false, "cat": "ai", "name": "Mistral AI", "logo": "mistral.svg", "shown": "white", "via": "openai-compatible", "home": "https://mistral.ai/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Mistral AI's OpenAI-compatible API, base URL `https://api.mistral.ai/v1`.", "ko": "Mistral AI의 OpenAI 호환 API, 기본 주소 `https://api.mistral.ai/v1`."},
      {"id": "together", "tested": false, "cat": "ai", "name": "Together AI", "logo": "together.svg", "via": "openai-compatible", "home": "https://www.together.ai/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Together AI's OpenAI-compatible API, base URL `https://api.together.ai/v1`.", "ko": "Together AI의 OpenAI 호환 API, 기본 주소 `https://api.together.ai/v1`."},
      {"id": "fireworks", "tested": false, "cat": "ai", "name": "Fireworks AI", "logo": "fireworks-glyph.svg", "shown": "white", "via": "openai-compatible", "home": "https://fireworks.ai/", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Fireworks AI's OpenAI-compatible API, base URL `https://api.fireworks.ai/inference/v1`.", "ko": "Fireworks AI의 OpenAI 호환 API, 기본 주소 `https://api.fireworks.ai/inference/v1`."},
      {"id": "compat-any", "tested": false, "cat": "ai", "line": true, "name": "Connect any OpenAI-compatible API", "name_ko": "OpenAI 호환 API로 연결", "via": "openai-compatible", "doc": ["getting-started.md", "4-enable-ai", "4-ai-활성화"], "en": "Any endpoint that answers the OpenAI Chat Completions API under a `/v1` base URL. A host that resolves to a private address goes in `ai.baseUrlAllowedHosts`.", "ko": "`/v1` 기본 주소에서 OpenAI Chat Completions API로 답하는 곳이면 됩니다. 사설 주소로 풀리는 호스트는 `ai.baseUrlAllowedHosts`에 넣습니다."},
      {"id": "claude-code", "tested": true, "cat": "ai", "name": "Claude Code", "logo": "claude-code.svg", "via": "mcp", "home": "https://claude.com/product/claude-code", "doc": ["ai-alerts.md", "connecting-ai-agents-mcp-server", "ai-에이전트-연결-mcp-서버"], "en": "Add Kubeast as an HTTP MCP server with one API key, in place of a kubeconfig. It uses the chat's read tools within the access of the key's owner.", "ko": "kubeconfig 대신 API 키 하나로 Kubeast를 HTTP MCP 서버로 추가합니다. 키 주인의 권한 안에서 채팅과 같은 읽기 도구를 씁니다."},
      {"id": "cursor", "tested": false, "cat": "ai", "name": "Cursor", "logo": "cursor.svg", "via": "mcp", "home": "https://cursor.com/", "doc": ["ai-alerts.md", "connecting-ai-agents-mcp-server", "ai-에이전트-연결-mcp-서버"], "en": "Connect Cursor to Kubeast's MCP server with an API key, in place of a kubeconfig.", "ko": "kubeconfig 대신 API 키로 Cursor를 Kubeast MCP 서버에 연결합니다."},
      {"id": "mcp-any", "tested": true, "cat": "ai", "line": true, "name": "Connect any standard MCP client (Streamable HTTP)", "name_ko": "표준 MCP 클라이언트로 연결(Streamable HTTP)", "via": "mcp", "home": "https://modelcontextprotocol.io/", "doc": ["ai-alerts.md", "connecting-ai-agents-mcp-server", "ai-에이전트-연결-mcp-서버"], "en": "Any Model Context Protocol client over Streamable HTTP. Results are masked before they are sent, and every call is audited. Off by default.", "ko": "Streamable HTTP를 쓰는 Model Context Protocol 클라이언트면 됩니다. 결과는 가린 뒤 보내고, 모든 호출을 감사 기록에 남깁니다. 기본은 꺼져 있습니다."},

      {"id": "prometheus", "tested": true, "cat": "observe", "name": "Prometheus", "logo": "prometheus.png", "via": "prometheus-api", "home": "https://prometheus.io/", "doc": ["cluster-requirements.md", "3-prometheus", "3-prometheus"], "en": "Drawer and dashboard graphs, CPU p95 and memory max in optimization, storage analysis and the AI's PromQL. Kubeast finds a Prometheus in each cluster or uses the one you name. Off by default.", "ko": "서랍·대시보드 그래프, 최적화의 CPU p95·메모리 최댓값, 스토리지 분석, AI의 PromQL에 씁니다. 클러스터마다 Prometheus를 찾거나 지정한 것을 씁니다. 기본은 꺼져 있습니다."},
      {"id": "victoriametrics", "tested": true, "cat": "observe", "name": "VictoriaMetrics", "logo": "victoriametrics.png", "via": "prometheus-api", "home": "https://victoriametrics.com/", "doc": ["cluster-requirements.md", "victoriametrics", "victoriametrics"], "en": "Read with the same queries as Prometheus. Without a Prometheus, Kubeast finds a single-node VictoriaMetrics; a cluster version is named by its vmselect Service with the tenant path.", "ko": "Prometheus와 같은 쿼리로 읽습니다. Prometheus가 없으면 단일 노드판을 찾고, 클러스터판은 tenant 경로를 붙인 vmselect Service를 지정합니다."},
      {"id": "thanos", "tested": false, "cat": "observe", "name": "Thanos", "logo": "thanos.svg", "via": "prometheus-api", "home": "https://thanos.io/", "doc": ["cluster-requirements.md", "how-kubeast-finds-it", "kubeast가-찾는-방법"], "en": "A central store for many clusters: enter its URL, authentication and the cluster's label value under Admin > Clusters > Edit. The metrics carry that cluster label.", "ko": "여러 클러스터의 중앙 저장소: Admin > Clusters > Edit에 주소·인증·클러스터 라벨 값을 적습니다. 지표에는 그 클러스터 라벨이 붙어 있어야 합니다."},
      {"id": "mimir", "tested": false, "cat": "observe", "name": "Grafana Mimir", "logo": "mimir.png", "via": "prometheus-api", "home": "https://grafana.com/oss/mimir/", "doc": ["cluster-requirements.md", "how-kubeast-finds-it", "kubeast가-찾는-방법"], "en": "A central store for many clusters: enter its URL, authentication and the cluster's label value under Admin > Clusters > Edit. The metrics carry that cluster label.", "ko": "여러 클러스터의 중앙 저장소: Admin > Clusters > Edit에 주소·인증·클러스터 라벨 값을 적습니다. 지표에는 그 클러스터 라벨이 붙어 있어야 합니다."},
      {"id": "prom-url", "tested": true, "cat": "observe", "line": true, "name": "Prometheus-compatible query URL", "name_ko": "Prometheus 호환 쿼리 주소", "via": "prometheus-api", "doc": ["cluster-requirements.md", "how-kubeast-finds-it", "kubeast가-찾는-방법"], "en": "A store that answers the Prometheus query API at a URL, such as one central store for many clusters: enter its URL, authentication and the cluster's label value under Admin > Clusters > Edit. The authentication goes as the Authorization header; no tenant header is sent.", "ko": "Prometheus 쿼리 API로 답하는 저장소를 주소로 씁니다(여러 클러스터의 중앙 저장소 등). Admin > Clusters > Edit에 주소·인증·클러스터 라벨 값을 적습니다. 인증은 Authorization 헤더로 가고, 테넌트 헤더는 보내지 않습니다."},
      {"id": "grafana-ds", "tested": true, "cat": "observe", "name": "Grafana data sources", "name_ko": "Grafana 데이터 소스", "logo": "grafana.svg", "via": "grafana-proxy", "home": "https://grafana.com/", "doc": ["cluster-requirements.md", "how-kubeast-finds-it", "kubeast가-찾는-방법"], "en": "When a store is only a Grafana data source, Kubeast reads it through Grafana. Logs and traces work the same way.", "ko": "저장소가 Grafana 데이터 소스로만 있으면 Grafana를 거쳐 읽습니다. 로그와 트레이스도 같습니다."},
      {"id": "metrics-server", "tested": true, "cat": "observe", "name": "metrics-server", "logo": "kubernetes.png", "via": "k8s-api", "home": "https://github.com/kubernetes-sigs/metrics-server", "doc": ["cluster-requirements.md", "2-metrics-server", "2-metrics-server"], "en": "Node and Pod usage on the node list, Monitoring and the node drawer, as `kubectl top` prints it, and optimization when there is no Prometheus.", "ko": "노드 목록·Monitoring·노드 서랍의 노드·Pod 사용량을 `kubectl top`과 같게 보여 주고, Prometheus가 없으면 최적화에도 씁니다."},
      {"id": "kube-state-metrics", "tested": true, "cat": "observe", "name": "kube-state-metrics", "logo": "kubernetes.png", "via": "prometheus-metrics", "home": "https://github.com/kubernetes/kube-state-metrics", "doc": ["cluster-requirements.md", "required-metrics", "있어야-하는-지표"], "en": "Pod, restart and HPA series for the dashboard and the Namespace, workload and HPA drawers.", "ko": "대시보드와 Namespace·워크로드·HPA 서랍에 쓰는 Pod·재시작·HPA 시계열입니다."},
      {"id": "node-exporter", "tested": true, "cat": "observe", "name": "Node exporter", "logo": "prometheus.png", "via": "prometheus-metrics", "home": "https://github.com/prometheus/node_exporter", "doc": ["cluster-requirements.md", "required-metrics", "있어야-하는-지표"], "en": "Each node's CPU, memory, disk, load and network, for the dashboard and the node drawer.", "ko": "대시보드와 노드 서랍에 쓰는 노드별 CPU·메모리·디스크·부하·네트워크입니다."},
      {"id": "ingress-nginx", "tested": false, "cat": "observe", "name": "ingress-nginx", "logo": "kubernetes.png", "via": "prometheus-metrics", "home": "https://kubernetes.github.io/ingress-nginx/", "doc": ["cluster-requirements.md", "7-apis-shown-when-present", "7-있으면-보여-주는-api"], "en": "The Ingress drawer's latency at the 50th, 95th and 99th percentiles, from the controller's metrics.", "ko": "Ingress 서랍의 지연 시간(50·95·99 백분위수)을 컨트롤러 지표에서 읽습니다."},
      {"id": "prometheus-operator", "tested": false, "cat": "observe", "name": "Prometheus Operator", "logo": "prometheus-operator.svg", "via": "chart", "home": "https://prometheus-operator.dev/", "doc": ["metrics.md", "scraping", "긁어가기"], "en": "Kubeast's own metrics: a ServiceMonitor for its five back-end services and a PrometheusRule of five alerts (six with an audit anchor sink). Kubeast also finds the Operator's `prometheus-operated` Service.", "ko": "Kubeast 자체 지표: 백엔드 서비스 다섯의 ServiceMonitor와 알람 다섯(감사 앵커 싱크가 있으면 여섯)의 PrometheusRule. Operator의 `prometheus-operated` Service도 찾습니다."},
      {"id": "otel", "tested": true, "cat": "observe", "name": "OpenTelemetry Collector", "tm": "®", "logo": "opentelemetry.svg", "via": "collector", "home": "https://opentelemetry.io/docs/collector/", "doc": ["cluster-requirements.md", "required-metrics", "있어야-하는-지표"], "en": "Its hostmetrics receiver can stand in for node-exporter, and it ships container logs to Loki over OTLP and spans to Tempo, with the cluster's name as a resource attribute.", "ko": "hostmetrics 수신기로 node-exporter를 대신할 수 있고, 컨테이너 로그는 OTLP로 Loki에, span은 Tempo에 보내며 클러스터 이름을 리소스 속성으로 붙입니다."},
      {"id": "loki", "tested": true, "cat": "observe", "name": "Loki", "logo": "loki.svg", "via": "store-api", "home": "https://grafana.com/oss/loki/", "doc": ["cluster-requirements.md", "14-log-store-log-search", "14-로그-저장소-로그-검색"], "en": "Find logs by text and time, also those of restarted or deleted Pods, with the user's own `pods/log` access. The AI also reads log patterns. Off by default.", "ko": "재시작했거나 지운 Pod의 로그도 글자와 시간으로 찾습니다. 사용자의 `pods/log` 권한을 따르고, AI는 로그 패턴도 읽습니다. 기본은 꺼져 있습니다."},
      {"id": "tempo", "tested": true, "cat": "observe", "name": "Tempo", "logo": "tempo.svg", "via": "store-api", "home": "https://grafana.com/oss/tempo/", "doc": ["cluster-requirements.md", "14-log-store-log-search", "14-로그-저장소-로그-검색"], "en": "The AI searches traces by cluster and namespace and reads their spans and TraceQL metrics. Off by default.", "ko": "AI가 클러스터와 Namespace별로 트레이스를 찾고, span과 TraceQL 지표를 읽습니다. 기본은 꺼져 있습니다."},
      {"id": "jaeger", "tested": true, "cat": "observe", "name": "Jaeger", "tm": "™", "logo": "jaeger.png", "via": "link", "home": "https://www.jaegertracing.io/", "doc": ["operations.md", "trace-links", "트레이스-링크"], "en": "Kubeast only makes links to traces in Jaeger, from a log line with a trace ID and from the Pod drawer. It does not read Jaeger's data.", "ko": "trace ID가 있는 로그 줄과 Pod 서랍에서 Jaeger의 트레이스로 가는 링크만 만듭니다. Jaeger 자료는 읽지 않습니다."},

      {"id": "alertmanager", "tested": true, "cat": "alerts", "name": "Alertmanager", "logo": "prometheus.png", "via": "webhook-in", "home": "https://prometheus.io/docs/alerting/latest/alertmanager/", "doc": ["cluster-requirements.md", "13-alertmanager-or-grafana-alerting-alerts-inbox--alerts--ai-investigation", "13-alertmanager-또는-grafana-알림-alerts-받은편지함--알림--ai-조사"], "en": "Alerts land in the Alerts inbox, and the AI looks into those of the severities you set (critical and warning by default). With the alert store on, Kubeast reads firing alerts and silences, and can create silences.", "ko": "알림이 Alerts 알림함에 모이고, 정한 심각도(기본 critical·warning)의 알림은 AI가 조사합니다. 알림 저장소를 켜면 울리는 알림과 사일런스를 읽고, 사일런스를 만들 수도 있습니다."},
      {"id": "grafana-alerting", "tested": true, "cat": "alerts", "name": "Grafana alerting", "name_ko": "Grafana 알림", "logo": "grafana.svg", "via": "webhook-in", "home": "https://grafana.com/docs/grafana/latest/alerting/", "doc": ["cluster-requirements.md", "13-alertmanager-or-grafana-alerting-alerts-inbox--alerts--ai-investigation", "13-alertmanager-또는-grafana-알림-alerts-받은편지함--알림--ai-조사"], "en": "A webhook contact point sends alerts to the same inbox, and Grafana's Alertmanager-compatible API gives the alerts and silences.", "ko": "웹훅 연락 지점이 같은 알림함으로 알림을 보내고, 알림과 사일런스는 Grafana의 Alertmanager 호환 API로 읽습니다."},
      {"id": "slack", "tested": true, "cat": "alerts", "name": "Slack", "logo": "slack.svg", "via": "sink", "home": "https://slack.com/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "The audit records you pick, such as deletes and node shells, go to a channel through an incoming webhook. Alert investigation summaries can go too.", "ko": "삭제나 노드 셸처럼 골라 둔 감사 기록을 수신 웹훅으로 채널에 보냅니다. 알림 조사 요약도 보낼 수 있습니다."},
      {"id": "teams", "tested": false, "cat": "alerts", "name": "Microsoft Teams", "text": "Teams", "via": "sink", "home": "https://www.microsoft.com/en-us/microsoft-teams/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "Chat notifications in Microsoft Teams through a webhook.", "ko": "웹훅으로 Microsoft Teams에 채팅 알림을 보냅니다."},
      {"id": "discord", "tested": true, "cat": "alerts", "name": "Discord", "logo": "discord.svg", "via": "sink", "home": "https://discord.com/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "Chat notifications in a Discord channel through a webhook.", "ko": "웹훅으로 Discord 채널에 채팅 알림을 보냅니다."},
      {"id": "telegram", "tested": true, "cat": "alerts", "name": "Telegram", "logo": "telegram.svg", "via": "sink", "home": "https://telegram.org/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "Chat notifications from a Telegram bot to the chat you name.", "ko": "Telegram 봇으로 지정한 대화방에 채팅 알림을 보냅니다."},
      {"id": "pagerduty", "tested": false, "cat": "alerts", "name": "PagerDuty", "logo": "pagerduty-white.svg", "via": "sink", "home": "https://www.pagerduty.com/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "On-call events through PagerDuty Events v2, one for each record.", "ko": "PagerDuty Events v2로 기록 하나마다 온콜 이벤트를 보냅니다."},
      {"id": "email", "tested": true, "cat": "alerts", "name": "Email", "name_ko": "이메일", "text": "SMTP", "via": "sink", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "Mail through your SMTP server, with STARTTLS or TLS. Alert investigation summaries can go too.", "ko": "SMTP 서버로 메일을 보냅니다. STARTTLS나 TLS를 쓰고, 알림 조사 요약도 보낼 수 있습니다."},
      {"id": "json-webhook", "tested": true, "cat": "alerts", "name": "JSON webhook", "name_ko": "JSON 웹훅", "text": "{ }", "via": "sink", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "JSON to any endpoint, such as a SIEM or n8n, with an HMAC signature header if you set one.", "ko": "SIEM이나 n8n 같은 곳으로 JSON을 보냅니다. HMAC 서명 헤더를 붙일 수 있습니다."},
      {"id": "file", "tested": true, "cat": "alerts", "name": "File", "name_ko": "파일", "text": "NDJSON", "via": "sink", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "NDJSON on a volume, for a log pipeline to pick up.", "ko": "볼륨에 NDJSON으로 써서 로그 파이프라인이 가져가게 합니다."},

      {"id": "cilium", "tested": true, "cat": "network", "name": "Cilium Hubble", "logo": "cilium.png", "via": "k8s-api", "home": "https://cilium.io/", "doc": ["cluster-requirements.md", "16-hubble-relay-network-flows", "16-hubble-relay-네트워크-흐름"], "en": "Recent flows from the Hubble Relay in the drawers and for the AI, and drops from Hubble metrics; the Resource Graph's traffic lines take either. Off by default.", "ko": "서랍과 AI의 최근 흐름은 Hubble Relay에서, 차단은 Hubble 지표에서 읽습니다. Resource Graph 통신 선은 둘 중 하나를 씁니다. 기본은 꺼져 있습니다."},
      {"id": "calico", "tested": true, "cat": "network", "name": "Calico Whisker", "logo": "calico.svg", "via": "k8s-api", "home": "https://docs.tigera.io/calico/", "doc": ["cluster-requirements.md", "16-hubble-relay-network-flows", "16-hubble-relay-네트워크-흐름"], "en": "Recent flows from Calico's Whisker.", "ko": "Calico Whisker의 최근 흐름을 읽습니다."},
      {"id": "retina", "tested": true, "cat": "network", "name": "Microsoft Retina", "logo": "retina.svg", "via": "k8s-api", "home": "https://retina.sh/", "doc": ["cluster-requirements.md", "16-hubble-relay-network-flows", "16-hubble-relay-네트워크-흐름"], "en": "Retina's Hubble control plane serves the same Relay. Kubeast names each Pod's workload from the Pods it lists as the user.", "ko": "Retina의 Hubble 컨트롤 플레인도 같은 Relay를 제공합니다. Kubeast는 사용자 권한으로 읽은 Pod에서 워크로드 이름을 붙입니다."},

      {"id": "nfm", "tested": false, "cat": "network", "name": "Network Flow Monitor", "logo": "cloudwatch-glyph.svg", "via": "aws-api", "home": "https://aws.amazon.com/cloudwatch/", "doc": ["cluster-requirements.md", "19-network-flow-monitor-top-talkers-eks", "19-network-flow-monitor-상위-통신-eks"], "en": "An EKS cluster's top talkers from an Amazon CloudWatch Network Flow Monitor monitor. Off by default.", "ko": "EKS 클러스터의 상위 통신을 Amazon CloudWatch Network Flow Monitor 모니터에서 읽습니다. 기본은 꺼져 있습니다."},
      {"id": "envoy-gateway", "tested": false, "cat": "network", "name": "Envoy Gateway", "logo": "envoy-gateway.svg", "via": "k8s-api", "home": "https://gateway.envoyproxy.io/", "doc": ["cluster-requirements.md", "7-apis-shown-when-present", "7-있으면-보여-주는-api"], "en": "The Gateway API lists, and Envoy Gateway's policies on the Gateway Policies page.", "ko": "Gateway API 목록과, Gateway Policies 화면의 Envoy Gateway 정책을 봅니다."},
      {"id": "istio", "tested": false, "cat": "network", "name": "Istio", "logo": "istio.svg", "via": "k8s-api", "home": "https://istio.io/", "doc": ["cluster-requirements.md", "7-apis-shown-when-present", "7-있으면-보여-주는-api"], "en": "The Gateway API lists, and Istio's policies (AuthorizationPolicy, DestinationRule and others) on the Gateway Policies page.", "ko": "Gateway API 목록과, Gateway Policies 화면의 Istio 정책(AuthorizationPolicy, DestinationRule 등)을 봅니다."},
      {"id": "kyverno", "tested": true, "cat": "cluster", "name": "Kyverno", "tm": "®", "logo": "kyverno.png", "via": "k8s-api", "home": "https://kyverno.io/", "doc": ["cluster-requirements.md", "5-policy-reports-policyreport", "5-정책-보고서-policyreport"], "en": "The PolicyReports Kyverno writes show on each object's drawer, on the Policy Reports page and for the AI. Kubeast only reads them.", "ko": "Kyverno가 쓴 PolicyReport를 리소스 서랍·Policy Reports 화면·AI에서 봅니다. Kubeast는 읽기만 합니다."},
      {"id": "policy-any", "tested": true, "cat": "cluster", "line": true, "name": "Any tool that writes PolicyReports (wgpolicyk8s.io)", "name_ko": "PolicyReport(wgpolicyk8s.io)를 쓰는 도구", "via": "k8s-api", "doc": ["cluster-requirements.md", "5-policy-reports-policyreport", "5-정책-보고서-policyreport"], "en": "A tool that writes the PolicyReport and ClusterPolicyReport objects of `wgpolicyk8s.io/v1alpha2`: Kubeast reads its reports as it reads Kyverno's.", "ko": "`wgpolicyk8s.io/v1alpha2`의 PolicyReport·ClusterPolicyReport를 쓰는 도구면 됩니다. Kubeast는 그 보고서를 Kyverno의 것과 같이 읽습니다."},
      {"id": "trivy-operator", "tested": false, "cat": "cluster", "name": "Trivy Operator", "logo": "trivy-operator-white.svg", "via": "k8s-api", "home": "https://aquasecurity.github.io/trivy-operator/", "doc": ["cluster-requirements.md", "5-policy-reports-policyreport", "5-정책-보고서-policyreport"], "en": "PolicyReports written by other tools on the same CRDs, such as Trivy Operator, are read the same way.", "ko": "Trivy Operator처럼 같은 CRD에 쓰는 다른 도구의 PolicyReport도 같은 방식으로 읽습니다."},
      {"id": "helm", "tested": true, "cat": "cluster", "name": "Helm", "logo": "helm.svg", "via": "k8s-api", "home": "https://helm.sh/", "doc": ["features.md", "-helm-release-management", "-helm-릴리스-관리"], "en": "Releases with their history, values and manifests. Rollback, upgrade, uninstall and test run after a dry-run preview.", "ko": "릴리스와 이력·values·매니페스트를 봅니다. 롤백·업그레이드·제거·테스트는 dry-run 미리 보기 뒤에 실행합니다."},
      {"id": "argo", "tested": true, "cat": "cluster", "name": "Argo® CD", "logo": "argo.png", "via": "k8s-api", "home": "https://argoproj.github.io/cd/", "doc": ["cluster-requirements.md", "12-argo-cd-guard", "12-argo-cd-가드"], "en": "With the guard on, objects Argo CD manages carry a badge, and edits to them warn or are refused. The AI reads Applications' sync and health.", "ko": "가드를 켜면 Argo CD가 관리하는 리소스에 배지가 붙고, 수정할 때 경고하거나 막습니다. AI는 Application의 동기화·건강 상태를 읽습니다."},
      {"id": "opencost", "tested": true, "cat": "cluster", "name": "OpenCost", "tm": "®", "logo": "opencost.svg", "via": "k8s-api", "home": "https://opencost.io/", "doc": ["cluster-requirements.md", "4-opencost-cost", "4-opencost-비용"], "en": "Costs by cluster, namespace and workload, and the cost column in optimization. Kubeast finds OpenCost in the cluster, and OpenCost sets the prices.", "ko": "클러스터·Namespace·워크로드별 비용과 최적화 표의 비용 열입니다. 클러스터 안의 OpenCost를 찾아 읽고, 가격은 OpenCost가 정합니다."},

      {"id": "vpa", "tested": false, "cat": "cluster", "name": "Vertical Pod Autoscaler", "logo": "kubernetes.png", "via": "k8s-api", "home": "https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler", "doc": ["cluster-requirements.md", "7-apis-shown-when-present", "7-있으면-보여-주는-api"], "en": "Where its CRD is installed, the VerticalPodAutoscalers list with the recommender's recommendations.", "ko": "CRD가 있으면 VerticalPodAutoscaler 목록과 recommender의 추천값을 봅니다."},
      {"id": "nvidia", "tested": false, "cat": "cluster", "name": "NVIDIA", "logo": "nvidia-white.svg", "via": "k8s-api", "home": "https://www.nvidia.com/", "doc": ["cluster-requirements.md", "6-gpu-and-dra", "6-gpudra"], "en": "GPU counts and allocation from the NVIDIA device plugin, models from GPU Feature Discovery's labels, and utilization, memory and temperature from the DCGM exporter's metrics.", "ko": "NVIDIA 장치 플러그인으로 GPU 수와 할당을, GPU Feature Discovery 라벨로 모델을, DCGM exporter 지표로 사용률·메모리·온도를 봅니다."},
      {"id": "amd", "tested": false, "cat": "cluster", "name": "AMD", "logo": "amd.svg", "via": "k8s-api", "home": "https://www.amd.com/", "doc": ["cluster-requirements.md", "6-gpu-and-dra", "6-gpudra"], "en": "GPU counts and allocation from AMD's device plugin or GPU Operator, and model, memory and driver from its node labeller.", "ko": "AMD 장치 플러그인이나 GPU Operator로 GPU 수와 할당을, 노드 라벨러로 모델·메모리·드라이버를 봅니다."},
      {"id": "intel", "tested": false, "cat": "cluster", "name": "Intel", "text": "Intel", "via": "k8s-api", "home": "https://www.intel.com/", "doc": ["cluster-requirements.md", "6-gpu-and-dra", "6-gpudra"], "en": "GPU counts and allocation from the Intel GPU plugin, and model and family from NFD labels.", "ko": "Intel GPU 플러그인으로 GPU 수와 할당을, NFD 라벨로 모델과 계열을 봅니다."},
      {"id": "s3", "tested": true, "cat": "platform", "name": "Amazon S3", "logo": "s3-bucket.svg", "via": "s3", "home": "https://aws.amazon.com/s3/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "Long-term copies of audit records as NDJSON gzip. With Object Lock in compliance mode, not even root deletes them during the retention period.", "ko": "감사 기록 사본을 NDJSON gzip으로 오래 보관합니다. Object Lock 컴플라이언스 모드면 보존 기간에는 root도 지울 수 없습니다."},
      {"id": "minio", "tested": false, "cat": "platform", "name": "MinIO", "logo": "minio.svg", "via": "s3-compatible", "home": "https://min.io/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "The same copies in MinIO: set its endpoint and path-style access.", "ko": "같은 사본을 MinIO에 둡니다. endpoint와 path-style 접근을 설정합니다."},
      {"id": "gcs", "tested": false, "cat": "platform", "name": "Google Cloud Storage", "logo": "gcs.svg", "via": "s3-compatible", "home": "https://cloud.google.com/storage", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "The same copies through Cloud Storage's S3-compatible endpoint.", "ko": "같은 사본을 Cloud Storage의 S3 호환 주소로 보냅니다."},
      {"id": "r2", "tested": false, "cat": "platform", "name": "Cloudflare R2", "logo": "cloudflare-white.svg", "via": "s3-compatible", "home": "https://www.cloudflare.com/developer-platform/products/r2/", "doc": ["security-audit.md", "audit-sinks-s3--webhook--email--file", "감사-싱크-s3--웹훅--메일--파일"], "en": "The same copies through R2's S3-compatible endpoint.", "ko": "같은 사본을 R2의 S3 호환 주소로 보냅니다."},
      {"id": "postgresql", "tested": true, "cat": "platform", "name": "PostgreSQL", "tm": "®", "logo": "postgresql.png", "via": "database", "home": "https://www.postgresql.org/", "doc": ["database-backup-restore.md", "what-lives-where", "무엇이-어디에-있나-what-lives-where"], "en": "Users, roles, clusters, conversations and audit records live in one PostgreSQL database, which the chart installs.", "ko": "사용자·역할·클러스터·대화·감사 기록을 PostgreSQL 데이터베이스 하나에 둡니다. 차트가 설치합니다."},
      {"id": "pg-external", "tested": true, "cat": "platform", "line": true, "name": "External PostgreSQL, directly or behind PgBouncer in session mode", "name_ko": "바깥 PostgreSQL(직접, 또는 PgBouncer session 모드 뒤)", "via": "database", "doc": ["database-backup-restore.md", "tls-to-the-database", "데이터베이스-tls-tls-to-the-database"], "en": "Point the chart at your own PostgreSQL (`postgresql.enabled: false`, `externalHost`), with TLS up to `verify-full`.", "ko": "차트를 직접 운영하는 PostgreSQL로 돌립니다(`postgresql.enabled: false`, `externalHost`). TLS는 `verify-full`까지 됩니다."},
      {"id": "rds", "tested": false, "cat": "platform", "name": "Amazon RDS", "logo": "rds-glyph.svg", "via": "database", "home": "https://aws.amazon.com/rds/postgresql/", "doc": ["database-backup-restore.md", "tls-to-the-database", "데이터베이스-tls-tls-to-the-database"], "en": "Amazon RDS for PostgreSQL as the external database, with the RDS CA bundle for `verify-full`.", "ko": "Amazon RDS for PostgreSQL을 외부 데이터베이스로 쓰고, `verify-full`에는 RDS CA 번들을 씁니다."},
      {"id": "pgbouncer", "tested": true, "cat": "platform", "name": "PgBouncer", "logo": "pgbouncer.svg", "via": "database", "home": "https://www.pgbouncer.org/", "doc": ["database-backup-restore.md", "tls-to-the-database", "데이터베이스-tls-tls-to-the-database"], "en": "Behind PgBouncer, use session pooling: two services each hold a session lock on one connection.", "ko": "PgBouncer 뒤에서는 세션 풀링을 씁니다. 두 서비스가 각각 연결 하나에 세션 잠금을 잡기 때문입니다."},
      {"id": "valkey", "tested": true, "cat": "platform", "name": "Valkey", "logo": "valkey.svg", "shown": "white", "via": "bundled", "home": "https://valkey.io/", "doc": ["configuration.md", "redis-users", "redis-사용자"], "en": "The chart's cache of cluster reads, where each service signs in as its own user. Without it, the cache stays in memory.", "ko": "차트에 들어 있는 클러스터 조회 캐시이고, 서비스마다 자기 사용자로 접속합니다. 끄면 메모리에 캐시합니다."},
      {"id": "kubernetes", "tested": true, "cat": "platform", "name": "Kubernetes", "tm": "®", "logo": "kubernetes.png", "via": "runs-on", "home": "https://kubernetes.io/", "doc": ["getting-started.md", "quick-start", "빠른-시작"], "en": "Install with the Helm chart or the install script, then add more clusters with a kubeconfig. Kubeast installs nothing on the clusters you register.", "ko": "Helm 차트나 설치 스크립트로 설치하고, 다른 클러스터는 kubeconfig로 추가합니다. 등록한 클러스터에는 아무것도 설치하지 않습니다."},
      {"id": "eks", "tested": true, "cat": "platform", "name": "Amazon EKS", "logo": "eks-glyph.svg", "via": "runs-on", "home": "https://aws.amazon.com/eks/", "doc": ["getting-started.md", "3-log-in-and-connect-a-cluster-connect-your-cluster", "3-로그인-후-클러스터-연결-connect-your-cluster"], "en": "Register EKS clusters with IAM: the kubeconfig runs `aws-iam-authenticator`, and Kubeast's IRSA role assumes the target role.", "ko": "EKS 클러스터를 IAM으로 등록합니다. kubeconfig가 `aws-iam-authenticator`를 실행하고, Kubeast의 IRSA 롤이 대상 롤을 맡습니다."},
      {"id": "aws-lbc", "tested": true, "cat": "platform", "name": "AWS Load Balancer Controller", "logo": "elb-alb.svg", "via": "runs-on", "home": "https://kubernetes-sigs.github.io/aws-load-balancer-controller/", "doc": ["high-availability.md", "before-you-start", "시작하기-전에"], "en": "Behind an Application Load Balancer that sends to Pod IPs, label the namespace for Pod readiness gates, so a new Pod takes traffic once its target is healthy.", "ko": "Pod IP로 보내는 Application Load Balancer 뒤에서는 Namespace에 Pod readiness gate 라벨을 달아, 새 Pod가 대상이 정상이 된 뒤에 트래픽을 받게 합니다."},
      {"id": "docker", "tested": true, "cat": "platform", "name": "Docker Compose", "logo": "docker-zero.svg", "via": "runs-on", "home": "https://docs.docker.com/compose/", "doc": ["getting-started.md", "option-3-docker-compose-single-host-no-cluster", "옵션-3-docker-compose-클러스터-없이-단일-호스트"], "en": "One host without a cluster: `install-docker.sh` starts the services with Docker Compose.", "ko": "클러스터 없는 단일 호스트에서는 `install-docker.sh`가 Docker Compose로 서비스를 띄웁니다."},
      {"id": "cosign", "tested": true, "cat": "platform", "name": "Sigstore cosign", "logo": "cosign.svg", "via": "release", "home": "https://www.sigstore.dev/", "doc": ["supply-chain.md", "verifying-an-image", "이미지-검증-verifying-an-image"], "en": "Every image and the chart are signed keyless with cosign. The signing identity is the release workflow, and the signature has an entry in the Rekor log.", "ko": "모든 이미지와 차트는 cosign으로 키 없이 서명합니다. 서명 주체는 릴리스 워크플로이고, 서명은 Rekor 로그에 남습니다."},
      {"id": "slsa", "tested": true, "cat": "platform", "name": "SLSA", "logo": "slsa.svg", "via": "release", "home": "https://slsa.dev/", "doc": ["supply-chain.md", "verifying-an-image", "이미지-검증-verifying-an-image"], "en": "A SLSA build-provenance attestation says which workflow, commit and runner built each image and the chart.", "ko": "SLSA 빌드 출처 증명이 이미지와 차트마다 어떤 워크플로·커밋·러너가 만들었는지 적습니다."},
      {"id": "sbom", "tested": true, "cat": "platform", "name": "SBOM (SPDX)", "logo": "spdx.svg", "via": "release", "home": "https://spdx.dev/", "doc": ["supply-chain.md", "verifying-an-image", "이미지-검증-verifying-an-image"], "en": "An SPDX SBOM for each image, attested next to it in the registry and kept with the release run.", "ko": "이미지마다 SPDX SBOM을 만들어 레지스트리에 증명으로 붙이고, 릴리스 실행에도 남깁니다."}
    ]
  } /* END DATA */;

  const section = document.getElementById('integrations');
  if (!section) return;
  const tabs = section.querySelector('.int-tabs'), wall = section.querySelector('.int-wall'), lines = section.querySelector('.int-lines'), panel = section.querySelector('.int-detail');
  const docsBase = 'https://github.com/junginho0901/Kubeast/blob/' + (section.dataset.docsTag || 'main') + '/docs/';
  const items = DATA.items.filter(item => !item.off);
  const byId = new Map(items.map(item => [item.id, item]));
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    (children || []).forEach(child => node.append(child));
    return node;
  };
  const words = (en, ko) => [el('span', {lang: 'en'}, rich(en)), el('span', {lang: 'ko'}, rich(ko))];
  // `code` in a text becomes a code element; nothing in a text is read as HTML.
  const rich = text => String(text).split('`').map((part, i) => i % 2 ? el('code', {}, [part]) : document.createTextNode(part));
  const newTab = () => el('span', {class: 'sr-only'}, words(' (opens in a new tab)', ' (새 탭에서 열림)'));
  const nameOf = item => item.name_ko ? words(item.name, item.name_ko) : [item.name].concat(item.tm ? [el('span', {class: 'tm'}, [item.tm])] : []);
  const plainName = (item, lang) => lang === 'ko' && item.name_ko ? item.name_ko : item.name + (item.tm || '');
  const inLine = item => Boolean(item.line);
  const logoOf = item => item.text
    ? el('span', {class: 'int-logo int-text', 'aria-hidden': 'true'}, [item.text])
    : el('span', {class: 'int-logo' + (item.shown ? ' int-' + item.shown : '')}, [el('img', {src: 'official-icons/' + item.logo, alt: ''})]);

  const pick = item => ({'data-int': item.id, 'aria-expanded': 'false', 'aria-controls': panel.id, type: 'button'});

  // The wall: a tile for every tool, in the list's order; the lines: a row of words for every standard path.
  items.forEach(item => {
    if (inLine(item)) lines.append(el('button', Object.assign({class: 'int-line', 'data-cat': item.cat}, pick(item)), [el('span', {class: 'int-line-tag'}, words('Standard', '표준')), el('span', {}, nameOf(item))]));
    else wall.append(el('button', Object.assign({class: 'int-tile', 'data-cat': item.cat}, pick(item)), [logoOf(item), el('span', {class: 'int-name'}, nameOf(item))]));
  });
  // A name breaks only between words: one with a word wider than its tile (VictoriaMetrics in a narrow column) is set
  // a little smaller, half a pixel at a time. Again when the width or the language changes, and for the tiles a
  // category shows.
  const fitNames = () => wall.querySelectorAll('.int-tile:not([hidden]) .int-name').forEach(name => {
    name.style.fontSize = '';
    let size = parseFloat(getComputedStyle(name).fontSize);
    while (name.scrollWidth > name.clientWidth && size > 9) {
      size -= 0.5;
      name.style.fontSize = size + 'px';
    }
  });
  fitNames();
  addEventListener('resize', fitNames, {passive: true});
  new MutationObserver(fitNames).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
  if (document.fonts) document.fonts.ready.then(fitNames);
  // The category buttons, each with the number of its tools.
  DATA.categories.forEach(([key, en, ko]) => {
    const count = key === 'all' ? items.length : items.filter(item => item.cat === key).length;
    tabs.append(el('button', {type: 'button', 'data-cat': key, 'aria-pressed': String(key === 'all')}, [...words(en, ko), el('small', {}, [String(count)])]));
  });

  function note(item) {
    const head = el('div', {class: 'int-detail-head'}, (inLine(item) ? [] : [logoOf(item)]).concat([el('h3', {}, nameOf(item))]));
    const via = DATA.via[item.via];
    const how = el('p', {class: 'int-via'}, [el('b', {}, words('Connects through', '연결 방식')), ': ', ...words(via.en, via.ko)]);
    const links = el('p', {class: 'int-links'});
    if (item.home) links.append(el('a', {href: item.home, target: '_blank', rel: 'noopener'}, [...words('Open ' + plainName(item, 'en'), plainName(item, 'ko') + ' 사이트'), newTab()]));
    if (item.doc) {
      const [file, en, ko] = item.doc;
      links.append(el('a', {lang: 'en', href: docsBase + file + (en ? '#' + en : ''), target: '_blank', rel: 'noopener'}, ['Kubeast docs', el('span', {class: 'sr-only'}, [' (opens in a new tab)'])]));
      links.append(el('a', {lang: 'ko', href: docsBase + 'ko/' + file + (ko ? '#' + ko : ''), target: '_blank', rel: 'noopener'}, ['Kubeast 문서', el('span', {class: 'sr-only'}, [' (새 탭에서 열림)'])]));
    }
    return [head, el('p', {lang: 'en'}, rich(item.en)), el('p', {lang: 'ko'}, rich(item.ko)), how, links];
  }

  // Motion: the site's curve (--ease), and none for a reader who asks for less motion.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'ease-out';
  const MOVE = 250, LEAVE = 180, ENTER = 200, FADE = 120;
  const moving = () => !still.matches && typeof wall.animate === 'function';
  // An animation calls `after` when it ends or is stopped; a new change stops those of the one before.
  const run = (animation, after) => { if (after) animation.onfinish = animation.oncancel = after; return animation; };
  const settle = list => list.splice(0).forEach(animation => animation.cancel());
  let swaps = [], shifts = [], closing = 0;

  // The note: its row opens from 0fr to 1fr (integrations.css), the card inside it, the words inside the card.
  const clip = el('div', {class: 'int-detail-clip'}), card = el('div', {class: 'int-detail-card'});
  clip.append(card);
  panel.append(clip);

  function close() {
    section.querySelectorAll('[data-int][aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (panel.hidden) return;
    settle(swaps);
    panel.classList.remove('is-open');
    const done = () => { panel.hidden = true; card.replaceChildren(); };
    if (!moving()) return done();
    const turn = ++closing;
    setTimeout(() => { if (turn === closing && !panel.classList.contains('is-open')) done(); }, MOVE + 40);
  }

  function open(button) {
    const body = el('div', {class: 'int-detail-body'}, note(byId.get(button.dataset.int)));
    const shown = !panel.hidden && panel.classList.contains('is-open');
    section.querySelectorAll('[data-int][aria-expanded="true"]').forEach(other => other.setAttribute('aria-expanded', 'false'));
    button.setAttribute('aria-expanded', 'true');
    closing++;
    if (!shown || !moving()) {
      settle(swaps);
      card.replaceChildren(body);
      panel.hidden = false;
      if (moving()) panel.getBoundingClientRect();
      panel.classList.add('is-open');
      // On a narrow screen the note can open below the screen: bring it up once it has opened.
      setTimeout(() => { if (panel.getBoundingClientRect().top > innerHeight - 64) panel.scrollIntoView({block: 'nearest'}); }, moving() ? MOVE : 0);
      return;
    }
    // Another tool while the note is open: the card's height goes to the new words, which fade in over the old ones.
    const from = card.getBoundingClientRect().height;
    settle(swaps);
    const old = card.querySelector('.int-detail-body');
    const at = {left: old.offsetLeft + 'px', top: old.offsetTop + 'px', width: old.offsetWidth + 'px'};
    old.setAttribute('aria-hidden', 'true');
    Object.assign(old.style, {position: 'absolute'}, at);
    card.prepend(body);
    const to = card.getBoundingClientRect().height;
    card.classList.add('int-sizing');
    swaps.push(run(card.animate([{height: from + 'px'}, {height: to + 'px'}], {duration: MOVE, easing: ease}), () => card.classList.remove('int-sizing')));
    swaps.push(run(old.animate([{opacity: 1}, {opacity: 0}], {duration: FADE, easing: 'ease-out', fill: 'forwards'}), () => old.remove()));
    swaps.push(body.animate([{opacity: 0}, {opacity: 1}], {duration: ENTER, delay: FADE / 2, easing: 'ease-out', fill: 'backwards'}));
  }

  function toggle(button) {
    if (button.getAttribute('aria-expanded') === 'true') return close();
    open(button);
  }

  // The size of a box as it shows now, also part way through a change.
  const sizeOf = box => {
    const style = getComputedStyle(box);
    return {height: box.getBoundingClientRect().height + 'px', marginTop: style.marginTop, paddingTop: style.paddingTop, borderTopWidth: style.borderTopWidth};
  };

  // A category leaves its own tools and lines and hides the others. With motion, a tile that goes fades and shrinks
  // where it was, one that stays slides from its old place to its new one, one that comes fades in, and each box
  // changes its height (first, last, invert, play: no library).
  function show(cat) {
    tabs.querySelectorAll('[data-cat]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cat === cat)));
    const animate = moving(), boxes = [wall, lines];
    const before = animate ? boxes.map(box => ({
      at: box.getBoundingClientRect(),
      size: sizeOf(box),
      tiles: new Map([...box.querySelectorAll('[data-int]')].filter(button => !button.hidden).map(button => [button, button.getBoundingClientRect()]))
    })) : [];
    settle(shifts);
    section.querySelectorAll('[data-int]').forEach(button => { button.hidden = cat !== 'all' && button.dataset.cat !== cat; });
    fitNames();
    lines.classList.toggle('int-lines-none', !lines.querySelector('[data-int]:not([hidden])'));
    const open = section.querySelector('[data-int][aria-expanded="true"]');
    if (open && open.hidden) close();
    if (!animate) return;
    boxes.forEach((box, i) => {
      const was = before[i], at = box.getBoundingClientRect();
      const inside = (rect, origin) => [rect.left - origin.left - box.clientLeft, rect.top - origin.top - box.clientTop];
      box.querySelectorAll('[data-int]').forEach(button => {
        const first = was.tiles.get(button);
        if (button.hidden) {
          if (!first) return;
          const [left, top] = inside(first, was.at), ghost = button.cloneNode(true);
          ['data-int', 'aria-controls', 'aria-expanded', 'hidden'].forEach(name => ghost.removeAttribute(name));
          ghost.classList.add('int-ghost');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.tabIndex = -1;
          Object.assign(ghost.style, {left: left + 'px', top: top + 'px', width: first.width + 'px', height: first.height + 'px'});
          box.append(ghost);
          shifts.push(run(ghost.animate([{opacity: 1, transform: 'none'}, {opacity: 0, transform: 'scale(.92)'}], {duration: LEAVE, easing: 'ease-out', fill: 'forwards'}), () => ghost.remove()));
          return;
        }
        if (!first) {
          shifts.push(button.animate([{opacity: 0, transform: 'scale(.92)'}, {opacity: 1, transform: 'none'}], {duration: ENTER, delay: LEAVE / 3, easing: ease, fill: 'backwards'}));
          return;
        }
        const [x0, y0] = inside(first, was.at), [x1, y1] = inside(button.getBoundingClientRect(), at);
        if (x0 !== x1 || y0 !== y1) shifts.push(button.animate([{transform: `translate(${x0 - x1}px, ${y0 - y1}px)`}, {transform: 'none'}], {duration: MOVE, easing: ease}));
      });
      const size = sizeOf(box);
      if (Object.keys(size).every(key => size[key] === was.size[key])) return;
      box.classList.add('int-sizing');
      shifts.push(run(box.animate([was.size, size], {duration: MOVE, easing: ease}), () => box.classList.remove('int-sizing')));
    });
  }

  section.addEventListener('click', event => {
    const tab = event.target.closest('.int-tabs [data-cat]');
    if (tab) return show(tab.dataset.cat);
    const button = event.target.closest('[data-int]');
    if (button && section.contains(button)) toggle(button);
  });
  section.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = section.querySelector('[data-int][aria-expanded="true"]');
    if (!open) return;
    close();
    open.focus();
    event.stopPropagation();
  });
})();
