**English** | [한국어](ko/getting-started.md)

# Installation and first setup

## Quick start

All component images and the Helm chart are published as **public packages on GitHub Container Registry (ghcr.io)**, so they install right away without building anything.
Public packages have no anonymous pull rate limit.

Install from the released chart (`oci://ghcr.io/junginho0901/charts/kubeast`), which carries that release's image versions.
`helm/kubeast` in the repository source is for development, so its image versions do not match the release.

### Option 1. Install script (a K8s cluster that is already running)

Download the tagged script, check its contents, then run it (do not run an unreviewed script directly with `curl | bash`).

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.0/install.sh
less install.sh
bash install.sh
```

Options:

```bash
# Change the NodePort (default 30333)
bash install.sh --node-port 30333

# LoadBalancer (cloud environments)
bash install.sh --load-balancer

# Set the namespace
bash install.sh --namespace my-ns

# Set the chart version
bash install.sh --version 0.7.0
```

> Prerequisites: `kubectl`, `helm`, and a reachable Kubernetes cluster.

### Option 2. Using Helm directly

```bash
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 \
  --namespace kubeast --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY     # optional: can also be registered in the UI later

# Lightest: console, management and audit only, without AI or cache (6 pods, docs/architecture.md "Resource usage")
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 -n kubeast --create-namespace \
  -f https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.0/helm/kubeast/values-minimal.yaml
```

### Option 3. Docker Compose (single host, no cluster)

```bash
git clone --branch v0.7.0 --depth 1 https://github.com/junginho0901/Kubeast.git
cd Kubeast

./install-docker.sh
#   --kubeconfig /path/to/kubeconfig.yaml   # kubeconfig of the cluster to manage
#   --port 9000                             # Gateway port (default 8000)
#   --uninstall                             # remove containers + volumes
```

`docker-compose` pulls the published images. By default it uses the version of the tag you checked out; set `KUBEAST_TAG` to change it.
To build from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### Uninstall

```bash
helm uninstall kubeast -n kubeast      # K8s
./install-docker.sh --uninstall        # Docker
```

---

## First setup after installation

### 1. Access

- **NodePort**: `http://<node-IP>:30333`
- **Port-forward**: `kubectl -n kubeast port-forward svc/gateway 8000:8000` → `http://localhost:8000`
- **Docker**: `http://localhost:8000`

### 2. Find the admin password

The initial admin password is **generated randomly at install time** (when `admin.password` is left empty), and **the install script prints it on screen when it finishes**.

```text
Default account:
  ID:       admin
  Password: KhHAm7GGGvXiT9ysnOiV     ← shown right in the install output
```

If you missed the output, you can look it up again at any time.

```bash
# K8s / Helm
kubectl -n kubeast get secret kubeast-secrets \
  -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d ; echo

# Docker — DEFAULT_ADMIN_PASSWORD in the .env file
grep DEFAULT_ADMIN_PASSWORD .env
```

To set the password yourself, pass `--set admin.password=<your-password>` at install time.

### 3. Log in and connect a cluster (Connect your cluster)

Log in with the `admin` account first. If no cluster is registered, you are taken to the `/setup` wizard right after login (the wizard and its API require admin permission). **Change the password right after logging in.**

- **In-cluster** — automatically connects the cluster Kubeast runs in, with its ServiceAccount permissions
- **External** — registers another cluster's kubeconfig (multi-cluster).
  - If you leave the API server address empty, the address actually used during the connection check is filled in.
  - For a cluster registered without an address, the connection test in **Admin > Clusters** fills it in.

**Cluster requirements**: Kubeast installs nothing on the clusters you register.
Each cluster must already have the permissions (RBAC). Features such as graphs, cost and policy reports read that cluster's metrics-server, Prometheus, OpenCost, Kyverno, etc.

- [docs/cluster-requirements.md](cluster-requirements.md) lists what each feature needs, how to find it, check commands and examples.
- Example values are in `deploy/examples/target-cluster/`.
- `scripts/render-target-rbac.sh` renders the permissions for registered clusters.

**EKS clusters** authenticate with IAM.
The k8s-service and tool-server images include `aws-iam-authenticator`, so the kubeconfig uses the exec plugin instead of static credentials.

- The Kubeast pod's IRSA role (`aws.irsaRoleArn` in `values.yaml`) assumes the target role given in `-r` (AssumeRole).
- The target cluster's access entry maps that role to a Kubernetes group.
- The group permissions are in `helm/kubeast/files/impersonation-rbac.yaml`.

```yaml
users:
- name: kubeast
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws-iam-authenticator
      args: ["token", "-i", "<cluster-name>", "-r", "arn:aws:iam::<account>:role/kubeast-target"]
      interactiveMode: Never
```

The exec command of a registered kubeconfig must be on the allow list (`multicluster.execCommands`, default `aws-iam-authenticator`).
Static key env vars such as `AWS_ACCESS_KEY_ID` are rejected.

### 4. Enable AI

To enable the AI assistant, register an API key for OpenAI, Anthropic, Gemini or another provider in **Admin > AI Models**.

The model dropdown shows the models the provider reports for that key and address:

- For Anthropic, ai-service calls `GET /v1/models`.
- For the others (OpenAI, Gemini, Ollama and OpenAI-compatible gateways), it calls `GET {base_url}/models`.
- The API behind it is `POST /api/v1/ai/model-configs/models` (admin only), with the same key and address rules as the connection test.
- Embedding, speech and image models are left out.
- If there is no key or the list cannot be fetched, the built-in list is shown with the reason. "Custom model name" also works.
- The browser does not call anything outside Kubeast. So even on an internal network, you get the list from the address in that setting (an internal gateway, Ollama).

To use only the console without AI, install with `ai.enabled: false`:

- ai-service, tool-server and the ModelConfig controller are not deployed.
- A new install has no CRD either. An install where AI was turned on and then off keeps the CRD and ModelConfigs.
- The gateway's `/api/v1/ai` returns JSON 503.
- The UI hides AI chat, the floating assistant, the AI admin pages and the MCP guide (`ai.enabled` in `/api/v1/cluster/features`).

When AI is on, ai-service keeps idle memory low: it loads the provider SDK only when it first creates a model client, and the MCP SDK only when `mcp.enabled` is on.

Anthropic (provider `anthropic`) is called through the Messages API (`/v1/messages`), not an OpenAI-compatible address.
The code is in `app/services/anthropic_messages.py`, and responses are converted to the same shape as other providers.

- **Sampling values**: `temperature`, `top_p` and `top_k` are not sent to Claude 4.7 and later models (including models whose version cannot be read from the name) — those models return 400 for anything other than the defaults.
- **thinking**: follows the model default (on by default for the Claude 5 family).
  - Between tool calls, the turn's thinking blocks are sent back as is (an API requirement).
  - Thinking tokens also count toward `max_tokens`, so for the Claude 5 family (including models with no version in the name) 4,096 is added to the caller's `max_tokens`. This is only a cap: you are billed only for what is used.
- **Prompt cache**: automatic caching (`cache_control`) is on by default. Turn it off with the model setting option `prompt_cache: false`. Input tokens in usage are the total input, including tokens read from the cache.
- Keep the key in `ANTHROPIC_API_KEY` (or `KUBEAST_AI_KEY_*`) as before. If the old compatible address (`https://api.anthropic.com/v1/`) is in base_url, it still works.

**Azure OpenAI (provider `azure`, CRD `azureopenai`)** uses only Azure's **v1 API** (since 2025-08, OpenAI-compatible, no dated `api-version`).
**Not yet verified against a real account**: connection and chat use the same call code and were checked only against a fake server and OpenAI-compatible servers.

- **Address**: `https://<resource>.openai.azure.com/openai/v1/` (`…services.ai.azure.com/openai/v1/` or a gateway address such as API Management also works). It cannot be left empty, so the key does not go anywhere else.
- **Model field**: the **deployment name**, not the model name (Azure AI Foundry → Deployments). There is no provider model list; type the name in.
- **Key**: kept in a `KUBEAST_AI_KEY_*` variable, it is sent as both the `Authorization: Bearer` header and the `api-key` header.
- **Not supported**: the old per-deployment address (`…/openai/deployments/<deployment>`) and dated `api-version`. Saving and the connection test reject them and point to the v1 address. Entra ID token authentication is not available yet either.
- **Private Link**: for resources that resolve to a private address through Private Link, add that host to `ai.baseUrlAllowedHosts`.
- **CRD**: put the v1 address in `spec.baseURL` (or `azureOpenAI.azureEndpoint`) and the deployment name in `spec.model`. `apiVersion`, `azureDeployment` and `azureAdToken` remain for kagent compatibility but are not used.

**Using a Claude subscription (provider `claude-code`, personal use)** lets you chat with the `claude setup-token` value of a Claude Pro/Max subscription instead of an API key.
Only Claude Code accepts subscription tokens, so ai-service starts Claude Code for each model call (Claude Agent SDK, `app/services/claude_code.py`).
The tools Claude Code calls are handled inside this process by the chat's tool code.
So these are the same as on the API key path: the tool list, approval cards for write tools, masking, and the `ai.tool.call` and `ai.chat.complete` audit records (provider `claude-code`).

- Turn it on **only in an install you use alone**. Anthropic's terms limit a subscription to personal use. Do not put it in a Kubeast used by a team or by multiple users. The admin screen shows the same warning when you pick this provider.
- **How to turn it on**: ① On your own PC, create a token (valid for 1 year) with `claude setup-token`, put it in `ai.claudeCodeOAuthToken` (or the `CLAUDE_CODE_OAUTH_TOKEN` key of `apiKeysSecret`), and roll out with `ai.providers.claudeCode.enabled: true`.
  - With this value on, ai-service switches to an image that contains Claude Code: the `<version>-claude-code` tag of the same version, about 250 MB larger. The default image does not have it.
  - For an image you build yourself, build with `--build-arg WITH_CLAUDE_CODE=true` and set `ai.providers.claudeCode.imageTagSuffix: ""`.
  - ② In **Admin > AI Models**, pick "Claude subscription"; the variable name is filled in as `CLAUDE_CODE_OAUTH_TOKEN`.
  - Save after the connection test.
  - If it cannot be used yet on this install (the value is off or the image has no Claude Code), it appears dimmed as "Not set up" in the list. Picking it shows the reason first and blocks the Test and Save buttons.
- **Isolation**:
  - Each run gets a temporary HOME and config directory and no Claude Code built-in tools (Bash, files, web). It reads no settings files or CLAUDE.md.
  - All environment variables ai-service received are overwritten with empty values, except path, proxy and CA variables. So model keys and DB addresses are not passed on.
  - The token goes only as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Rules**:
  - Only claude-code can use `CLAUDE_CODE_OAUTH_TOKEN`, and claude-code does not accept base_url or other providers' key variables.
  - On an install where it is off, saving a new claude-code setting is rejected with 400, and the connection test shows the reason.
- **Limits**:
  - Concurrent turns are capped at `maxConcurrent` (default 1; the rest wait).
  - One turn is capped at `turnTimeoutSeconds` (default 300 seconds) and `maxTurns` (default 10 model calls).
  - Each turn starts one Claude Code process (up to about 300 MB). If you raise `maxConcurrent`, also raise `resources.aiService.limits.memory`.
- **Alert → AI investigation** also runs on this provider.
  - Investigations use one slot separate from chat (the investigator runs one at a time), so chat does not wait during an investigation.
  - With investigation on, up to `maxConcurrent` + 1 Claude Code processes therefore run.
  - The step cap is `maxSteps`, the same as with an API key. The last step is a report without tools.
- **Not supported**: provider model list (built-in list or type the name in).
