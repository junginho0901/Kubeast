# Taking a logo out

When an owner asks, its logos go in one commit. `git grep -n <file name> -- site` lists every line to look at. Each
tool of Integrations is one entry of `items` in `integrations.js` on a line of its own, and each trademark sentence of
the two footers is a line of its own in `index.html`.

No tile turns into a text tile. Each entry showing the owner's file goes; the other tiles stay where they are. The
Kubernetes logo of the architecture diagram is in `index.html` too.

| Owner | Files to delete | Entries in `integrations.js` (category) | Footer sentence (en and ko) |
| --- | --- | --- | --- |
| Grafana Labs | `grafana.svg`, `loki.svg`, `tempo.svg`, `mimir.png` (and the unshown `alloy.svg`) | Grafana data sources, Loki, Tempo, Grafana Mimir (Metrics, logs and traces); Grafana alerting (Alerts and notifications) | stays while the text names them |
| OpenAI | `openai.svg` | OpenAI (AI models and agents) | "OpenAI and the OpenAI logo …" goes |
| Anthropic | `anthropic.svg`, `claude-code.svg` (and the unshown `claude.svg`) | Anthropic, Claude Code (AI models and agents); the entry `claude-sub`, kept off | "Claude, Claude Code and Anthropic …" goes |
| Google LLC | `google.svg`, `gemini.svg`, `gcs.svg` | Google (Sign-in); Google Gemini (AI models and agents); Google Cloud Storage (Storage and install) | "Google, Gemini and Google Cloud Storage …" goes |
| Ollama Inc. | `ollama.png` | Ollama (AI models and agents) | "Ollama …" goes |
| Microsoft Corporation | `retina.svg`, `entra-id.svg`, `azure-openai.svg` | Microsoft Retina (Network); Microsoft Entra ID (Sign-in); Azure OpenAI (AI models and agents) | "Microsoft, Microsoft Entra ID, Azure OpenAI and Microsoft Teams … Retina and its logo …" goes while no text names them |
| Amazon Web Services, Inc. | `s3-bucket.svg`, `eks-glyph.svg`, `elb-alb.svg`, `rds-glyph.svg`, `cloudwatch-glyph.svg` (and the unshown `cloudwatch.svg`, `rds.svg`, `s3.svg`, `elb.svg`, `eks.svg`) | Amazon S3, Amazon EKS, AWS Load Balancer Controller, Amazon RDS (Storage and install); Network Flow Monitor (Network) | stays while the text names them |
| NVIDIA Corporation | `nvidia-white.svg` | NVIDIA (Cluster tools) | "NVIDIA and the NVIDIA logo …" goes |
| Anysphere, Inc. | `cursor.svg` | Cursor (AI models and agents) | "Cursor …" goes |
| Groq LLC | `groq-glyph.svg` (and the unshown `groq.svg`) | Groq (AI models and agents) | its name in "The other names and logos …" goes |
| Fireworks AI, Inc. | `fireworks-glyph.svg` (and the unshown `fireworks.svg`) | Fireworks AI (AI models and agents) | its name in "The other names and logos …" goes |
| PostgreSQL Community Association of Canada | `postgresql.png` | PostgreSQL (Storage and install) | stays while the text names them |
| Tigera, Inc. | `calico.svg` | Calico Whisker (Network) | "Calico …" goes |
| Any other owner in the first table of `NOTICE.md` | its files | the entries showing them | its name in "The other names and logos …" goes |
| An owner of a file that is not shown | its files | none | none |
| The Linux Foundation | its files of `files` in `source-index.json` | the entries showing them; the architecture diagram's Kubernetes logo | stays while the text names them |

In the same commit:

- `NOTICE.md`: the file's table row and the owner's trademark sentence. `source-index.json`: its entry.
- The sentence that Kubeast is not affiliated with these owners keeps the owner's name while a note still names it.
