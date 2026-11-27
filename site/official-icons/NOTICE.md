# Project logos on this site

The logos name the tools Kubeast connects to. They are their owners' own files, unchanged, but five: `eks-glyph.svg`,
`rds-glyph.svg` and `cloudwatch-glyph.svg` are the official AWS icons of Amazon EKS, Amazon RDS and Amazon CloudWatch
with their background squares removed, and `groq-glyph.svg` and `fireworks-glyph.svg` are the icons groq.com and
fireworks.ai serve with their squares removed; their drawings are unchanged. They are shown without changes to shape or
proportions. Four files drawn dark, whose owners offer no light version we could download, are shown with their
colours reversed so that they read on the dark page: the Ollama logo with its colours inverted, the Valkey, Mistral AI
and Fireworks AI logos in one white colour. The files themselves are unchanged, and every other logo is shown in its own colours. Each logo links to its owner's page: the
Kubernetes logo in the architecture diagram, the others in the note that opens under the wall of Integrations when
their tile is picked. Logos stay smaller than the Kubeast name. Showing a logo does not mean that its project or its
owner sponsors or endorses Kubeast. A logo is taken out when its owner asks; `TAKEDOWN.md` says what to remove for each
owner.

Integrations shows the tools Kubeast connects to, and the standard paths as lines of words that name no product.

A part of a project with no logo of its own shows its project's logo: Alertmanager and Node exporter the Prometheus
logo; metrics-server, kube-state-metrics, ingress-nginx and the Vertical Pod Autoscaler (Kubernetes projects) the
Kubernetes logo.

Amazon S3 shows the S3 Bucket resource icon and the AWS Load Balancer Controller the Application Load Balancer resource
icon of Elastic Load Balancing, both drawn without a ground. The package has no resource icon of EKS itself, so Amazon
EKS shows `eks-glyph.svg`: background square removed from the official icon; the drawing is unchanged. Amazon RDS and
the Network Flow Monitor of Amazon CloudWatch show `rds-glyph.svg` and `cloudwatch-glyph.svg`, made the same way.

These are shown as words, with no logo: email, the JSON webhook and the NDJSON file, since they are no product;
Microsoft Teams and Intel, since no logo file was found on their owners' pages.

Some files in this folder are not shown; the second table below lists them. They stay here so that a tool can come
back without another download.

## CNCF projects

`argo.png`, `cilium.png`, `helm.svg`, `jaeger.png`, `keycloak.svg`, `kubernetes.png`, `kyverno.png`, `opencost.svg` and
`prometheus.png` come from [cncf/artwork](https://github.com/cncf/artwork) at commit
`4b6ce68638398f035f4879af9760d85e46265951`; `source-index.json` lists each file's path, URL, git blob and SHA-256.
Helm and OpenCost are the white versions from that repository, Keycloak the colour version. They are used under the
Linux Foundation trademark usage guidelines quoted in `LICENSE.md`, which is that repository's file and is about these
files only. `jaeger.png` is shown again, under Metrics, logs and traces.

`opentelemetry.svg` comes from the same repository at the same commit, added for Integrations; `source-index.json`
lists it in `files` with `added`. So do `thanos.svg`, `envoy-gateway.svg` and `istio.svg`, which are shown; two more
files of that commit with `added` are not shown (second table below).

Kubernetes®, Prometheus®, Helm®, Argo®, Kyverno®, OpenCost®, Cilium® and OpenTelemetry® are registered trademarks, and
Jaeger™ and Keycloak™ are trademarks, of The Linux Foundation. Kubeast is not affiliated with, endorsed or sponsored by
The Linux Foundation, the Cloud Native Computing Foundation or these projects.

## Model Context Protocol

`mcp.svg` is `docs/favicon.svg` of
[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) at commit
`1c5f400671ba9ac6d558de907b815be4d2c37548`, the mark the project's site uses as its icon; `source-index.json` lists its
URL, git blob and SHA-256. The project's site points to the [LF Projects trademark
policy](https://lfprojects.org/policies/trademark-policy/), which allows a project's logo as a link to that project's
home page. The repository's `LICENSE` says the project is moving from the MIT License to Apache-2.0, with documentation
under CC-BY-4.0.
`docs/favicon.svg` was last changed on 2025-06-16 (commit `3b05e1498`), before that move began (2026-01-05), so the
file is under the MIT License.
It is not shown: Integrations names the MCP path as a line of words.

Model Context Protocol® is a registered trademark of LF Projects, LLC. Kubeast is not affiliated with, endorsed or
sponsored by LF Projects, LLC or the Model Context Protocol project.

## Logos of other owners

`source-index.json` (`vendor_logos`) lists each file's URL, archive, git blob, SHA-256, the owner's policy and its
address for questions. Each file is shown as the owner publishes it, scaled only, and never larger than the Kubeast name.

The status is one of these:

- `pending answer`: the owner was asked and has not decided yet.
- `permission granted`: the owner gave written permission for its logos on this site; the row says when and gives the
  owner's reference.
- `refused by form, not asked`: the owner's form turned the request away before anyone could be asked.
- `no policy published`: the owner offers the file for download and publishes no rule for the logo, only how to write
  its name.
- `not asked`: added for Integrations from the owner's own page or repository; the owner has not been asked yet.

Shown:

| File | Owner | Source | Shown in | Links to | Status |
| --- | --- | --- | --- | --- | --- |
| `grafana.svg` | Grafana Labs | the official file Grafana Labs sent (`Grafana_Logo_Swirl_FullColor.svg`) | Metrics, logs and traces (Grafana data sources); Alerts and notifications (Grafana alerting) | https://grafana.com/, https://grafana.com/docs/grafana/latest/alerting/ | permission granted by Grafana Labs on 2026-11-26 (ticket #253224) |
| `loki.svg` | Grafana Labs | the official file Grafana Labs sent (`GrafanaLogo_Loki_icon.svg`) | Metrics, logs and traces | https://grafana.com/oss/loki/ | permission granted by Grafana Labs on 2026-11-26 (ticket #253224) |
| `tempo.svg` | Grafana Labs | the official file Grafana Labs sent (`GrafanaLogo_Tempo_icon.svg`) | Metrics, logs and traces | https://grafana.com/oss/tempo/ | permission granted by Grafana Labs on 2026-11-26 (ticket #253224) |
| `mimir.png` | Grafana Labs | `images/logo.png` of grafana/mimir at `d0aef6145cbba5bba7868b7c90994c24e1934ea5` | Metrics, logs and traces | https://grafana.com/oss/mimir/ | not among the three files Grafana Labs permitted (Grafana, Loki, Tempo); Grafana Labs is told in the reply that thanks it |
| `openai.svg` | OpenAI | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg` in `openai-logos.zip` from openai.com/brand | AI models and agents | https://openai.com/ | pending answer |
| `anthropic.svg` | Anthropic | `Anthropic symbol - Ivory.svg` in the press kit linked on anthropic.com/news | AI models and agents | https://www.anthropic.com/ | pending answer |
| `claude-code.svg` | Anthropic | `Claude Code logo - Ivory.svg` in the same press kit | AI models and agents | https://claude.com/product/claude-code | pending answer |
| `cursor.svg` | Anysphere, Inc. | `General Logos/Cube/SVG/CUBE_2D_DARK.svg` in the brand assets of cursor.com/brand | AI models and agents | https://cursor.com/ | no policy published |
| `azure-openai.svg` | Microsoft Corporation | `03438-icon-service-Azure-OpenAI.svg` in the Azure public service icons V25 (learn.microsoft.com) | AI models and agents | https://azure.microsoft.com/en-us/products/ai-foundry/models/openai | not asked; Microsoft's icon terms below |
| `litellm.png` | BerriAI (LiteLLM) | `litellm_logo_dark.png` of BerriAI/litellm (no brand page found) | AI models and agents | https://www.litellm.ai/ | not asked |
| `groq-glyph.svg` | Groq LLC | the icon groq.com serves (`groq.svg`; no brand page), background removed; the drawing is unchanged | AI models and agents | https://groq.com/ | not asked |
| `deepseek.svg` | Hangzhou DeepSeek Artificial Intelligence Co., Ltd. | `figures/logo.svg` of deepseek-ai/DeepSeek-V2 | AI models and agents | https://www.deepseek.com/ | not asked |
| `mistral.svg` | Mistral AI | `images/logos/logo-mistral.svg` that mistral.ai serves (its brand kit answered 403); shown in one white colour, as the white lockup its brand page shows | AI models and agents | https://mistral.ai/ | not asked |
| `together.svg` | Together Computer, Inc. | the logo suite of together.ai/brand | AI models and agents | https://www.together.ai/ | not asked |
| `fireworks-glyph.svg` | Fireworks AI, Inc. | the icon fireworks.ai serves (`fireworks.svg`; no brand page), background removed; shown reversed, in one white colour; the drawing is unchanged | AI models and agents | https://fireworks.ai/ | not asked |
| `gemini.svg` | Google LLC | the icon gemini.google serves | AI models and agents | https://ai.google.dev/ | refused by form, not asked (Google's brand hub takes corporate email addresses only) |
| `google.svg` | Google LLC | the Sign in with Google icon button (dark, no text) in `signin-assets.zip` of developers.google.com/identity/branding-guidelines | Sign-in | https://developers.google.com/identity | not asked |
| `entra-id.svg` | Microsoft Corporation | `Microsoft Entra ID color icon.svg` in the Entra architecture icons (learn.microsoft.com) | Sign-in | https://www.microsoft.com/en-us/security/business/identity-access/microsoft-entra-id | not asked; Microsoft's icon terms below |
| `okta.png` | Okta, Inc. | `Okta_Aura Lockup_White_RGB.png` in the logos archive of okta.com's newsroom | Sign-in | https://www.okta.com/ | not asked |
| `ollama.png` | Ollama Inc. | `public/ollama.png` on ollama.com (no brand page); shown with its colours inverted | AI models and agents | https://ollama.com/ | pending answer |
| `retina.svg` | Microsoft Corporation | `site/static/img/Retina-logo.svg` of microsoft/retina at `bf7a1e52f6a211019d9239d92946d0af96813931` | Network | https://retina.sh/ | pending answer |
| `calico.svg` | Tigera, Inc. | `calico-icon.svg` that tigera.io's newsroom page serves (no press kit) | Network | https://docs.tigera.io/calico/ | pending answer |
| `victoriametrics.png` | Victoria Metrics Inc. | `SYMBOL/symbol-white.png` in `VM_logo.zip` of VictoriaMetrics/VictoriaMetrics, with its usage rules | Metrics, logs and traces | https://victoriametrics.com/ | not asked |
| `slack.svg` | Slack Technologies, LLC | the mark slack.com/media-kit serves | Alerts and notifications | https://slack.com/ | not asked |
| `discord.svg` | Discord Inc. | `Discord-Symbol-Blurple.svg` from discord.com/branding | Alerts and notifications | https://discord.com/ | not asked |
| `telegram.svg` | Telegram Messenger Inc. | the logo telegram.org serves (no brand page found) | Alerts and notifications | https://telegram.org/ | not asked |
| `pagerduty-white.svg` | PagerDuty, Inc. | `logos/pagerduty-monochrome-white.svg` that pagerduty.com serves (its brand guide is on Brandfolder) | Alerts and notifications | https://www.pagerduty.com/ | not asked |
| `prometheus-operator.svg` | Prometheus Operator project | `favicon.svg` of prometheus-operator.dev (`prometheus-operator-logo`) | Metrics, logs and traces | https://prometheus-operator.dev/ | not asked |
| `cloudwatch-glyph.svg` | Amazon Web Services, Inc. | `Arch_Amazon-CloudWatch_64.svg` of the AWS Architecture Icons package (`cloudwatch.svg`), background square removed; the drawing is unchanged | Network (Network Flow Monitor) | https://aws.amazon.com/cloudwatch/ | not asked |
| `trivy-operator-white.svg` | Aqua Security Software Ltd. | `docs/images/trivy-operator-icon-white.svg` of aquasecurity/trivy-operator at `689215dd79a7a6115b053ffb262086f3ad401656` | Cluster tools | https://aquasecurity.github.io/trivy-operator/ | not asked |
| `nvidia-white.svg` | NVIDIA Corporation | `nvidia-logo-white.svg`, at the path of `nvidia-logo-black.svg` that nvidia.com serves | Cluster tools | https://www.nvidia.com/ | not asked; NVIDIA's guideline below |
| `amd.svg` | Advanced Micro Devices, Inc. | `amd-header-logo.svg` that amd.com serves in its header | Cluster tools | https://www.amd.com/ | not asked |
| `pgbouncer.svg` | PgBouncer project | `doc/pgbouncer-logo.svg` of pgbouncer/pgbouncer | Storage and install | https://www.pgbouncer.org/ | not asked |
| `valkey.svg` | LF Projects, LLC | `static/img/Valkey-logo.svg` of valkey-io/valkey-io.github.io; shown in one white colour | Storage and install | https://valkey.io/ | not asked |
| `docker-zero.svg` | Docker, Inc. | `docker-mark-zero.svg`, the Zero colourway of the mark, at the path of the mark docker.com's media resources page serves; that page names Zero on Ink one of five approved colourways | Storage and install (Docker Compose) | https://docs.docker.com/compose/ | not asked |
| `s3-bucket.svg` | Amazon Web Services, Inc. | `Res_Amazon-Simple-Storage-Service_Bucket_48.svg` in the AWS Architecture Icons package of aws.amazon.com/architecture/icons | Storage and install | https://aws.amazon.com/s3/ | not asked |
| `eks-glyph.svg` | Amazon Web Services, Inc. | `Arch_Amazon-Elastic-Kubernetes-Service_64.svg` in the same package (`eks.svg`), background square removed; the drawing is unchanged | Storage and install | https://aws.amazon.com/eks/ | not asked |
| `elb-alb.svg` | Amazon Web Services, Inc. | `Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg` in the same package | Storage and install (AWS Load Balancer Controller) | https://kubernetes-sigs.github.io/aws-load-balancer-controller/ | not asked |
| `postgresql.png` | PostgreSQL Community Association of Canada | `elephant.png`, the first form of the Elephant Logo (Slonik) its trademark policy page shows | Storage and install | https://www.postgresql.org/ | not asked |
| `rds-glyph.svg` | Amazon Web Services, Inc. | `Arch_Amazon-RDS_64.svg` of the same package (`rds.svg`), background square removed; the drawing is unchanged | Storage and install | https://aws.amazon.com/rds/postgresql/ | not asked |
| `minio.svg` | MinIO, Inc. | `.github/logo.svg` of minio/minio | Storage and install | https://min.io/ | not asked |
| `gcs.svg` | Google LLC | `Cloud_Storage-512-color.svg` in `core-products-icons.zip` of cloud.google.com/icons | Storage and install | https://cloud.google.com/storage | not asked |
| `cloudflare-white.svg` | Cloudflare, Inc. | `CF_logo_horizontal_singlecolor_wht.svg` linked from cloudflare.com/press/press-kit | Storage and install (Cloudflare R2) | https://www.cloudflare.com/developer-platform/products/r2/ | not asked |
| `cosign.svg` | The Linux Foundation (Sigstore) | `artwork/cosign/icons/color/sigstore_cosign-icon-color.svg` of sigstore/community | Storage and install | https://www.sigstore.dev/ | not asked |
| `slsa.svg` | The Linux Foundation (SLSA) | `www/images/slsa-dancing-goose-logo.svg` of slsa-framework/slsa | Storage and install | https://slsa.dev/ | not asked |
| `spdx.svg` | The Linux Foundation (SPDX) | the white logo spdx.dev serves | Storage and install | https://spdx.dev/ | not asked |

Kept in this folder, not shown (their `source-index.json` entries say where each came from):

| File | Owner | Status |
| --- | --- | --- |
| `claude.svg` | Anthropic | not shown; pending answer |
| `mcp.svg` | LF Projects, LLC | not shown |
| `alloy.svg` | Grafana Labs | not shown; not asked |
| `cloudwatch.svg`, `rds.svg`, `s3.svg`, `elb.svg`, `eks.svg` | Amazon Web Services, Inc. | not shown (service icons on a coloured ground; `cloudwatch-glyph.svg`, `rds-glyph.svg`, `s3-bucket.svg`, `elb-alb.svg` and `eks-glyph.svg` are shown); not asked |
| `docker.svg` | Docker, Inc. | not shown (the Ether colourway, drawn dark; `docker-zero.svg` is shown); not asked |
| `groq.svg` | Groq LLC | not shown (on an orange square; `groq-glyph.svg` is shown); not asked |
| `fireworks.svg` | Fireworks AI, Inc. | not shown (on a light rounded square; `fireworks-glyph.svg` is shown); not asked |
| `trivy-operator.png` | Aqua Security Software Ltd. | not shown (drawn dark; `trivy-operator-white.svg` is shown); not asked |
| `cloudflare.png` | Cloudflare, Inc. | not shown (drawn dark; `cloudflare-white.svg` is shown); not asked |
| `kgateway.svg`, `external-secrets.svg` | The Linux Foundation | not shown |

What some owners say about their files, in their words:

- Microsoft, on [Azure architecture icons](https://learn.microsoft.com/en-us/azure/architecture/icons/) (read on
  2026-11-26): "Microsoft permits the use of these icons in architectural diagrams, training materials, or
  documentation. You can copy, distribute, and display the icons only for the permitted use unless granted explicit
  permission by Microsoft. Microsoft reserves all other rights." Its [Entra
  page](https://learn.microsoft.com/en-us/entra/architecture/architecture-icons) adds: "Don't use Microsoft product
  icons in Marketing communications."
- NVIDIA, in its [logo and brand
  guidelines](https://www.nvidia.com/en-us/about-nvidia/legal-info/logo-brand-usage/) (read on 2026-11-26): "These
  assets may not be used in any manner that isn't expressly authorized in writing by NVIDIA."
- Grafana Labs permitted three files on 2026-11-26 (ticket #253224): `grafana.svg`, `loki.svg` and `tempo.svg`.
  `mimir.png` is not among them; Grafana Labs is told in the reply that thanks it.

- AWS, on [aws.amazon.com/architecture/icons](https://aws.amazon.com/architecture/icons/) (read on 2026-11-26): "We
  allow customers and partners to use these toolkits and assets to create architecture diagrams."
- The PostgreSQL Community Association of Canada, in its [trademark
  policy](https://www.postgresql.org/about/policies/trademarks/) (last updated November 20, 2024; read on 2026-11-26):
  "The marks should not be modified in any way without prior approval. They should not be presented with other
  trademarks or logos." The Slonik is shown unchanged, among the other logos of Integrations.

Grafana®, Loki® and Tempo® are registered trademarks of Grafana Labs, and Grafana Mimir is a trademark of Grafana Labs.
OpenAI and the OpenAI logo are trademarks of OpenAI. Claude, Claude Code and Anthropic are trademarks of Anthropic.
Google, Gemini and Google Cloud Storage are trademarks of Google LLC. Microsoft, Microsoft Entra ID, Azure OpenAI and
Microsoft Teams are trademarks of the Microsoft group of companies, and Retina and its logo belong to Microsoft
Corporation. Amazon Web Services, AWS, Amazon EKS, Amazon S3, Elastic Load Balancing, Amazon RDS and Amazon CloudWatch
are trademarks of Amazon.com, Inc. or its affiliates. Postgres, PostgreSQL and the Slonik Logo are trademarks or
registered trademarks of the PostgreSQL Community Association of Canada. NVIDIA and the NVIDIA logo are trademarks of
NVIDIA Corporation. Ollama is a trademark of Ollama Inc. Calico is a trademark of Tigera, Inc. Cursor is a trademark of
Anysphere, Inc. The other names and logos shown under Integrations belong to the owners in the first table. Kubeast is
not affiliated with, endorsed or sponsored by Grafana Labs, OpenAI, Anthropic, Google LLC, Microsoft Corporation,
Amazon.com, Inc., NVIDIA Corporation, Ollama Inc., Tigera, Inc., Anysphere, Inc. or any other owner named here.
