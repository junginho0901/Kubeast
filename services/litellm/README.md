# LiteLLM Gateway (Optional)

This repository can optionally run a local OpenAI-compatible LLM gateway using LiteLLM.

## Why

- Use multiple providers (OpenAI / Claude / Gemini / local LLM) through a single `/v1/*` API.
- Keep the rest of the app unchanged: `ai-service` still uses the OpenAI SDK.

## How to run (MSA)

1) Fill in `.env` with at least one provider key:

- `OPENAI_API_KEY` (OpenAI)
- `ANTHROPIC_API_KEY` (Claude)
- `GEMINI_API_KEY` (Gemini)

2) Start with the gateway compose overlay:

```bash
docker compose -f docker-compose.msa.yml -f docker-compose.llm-gateway.yml up -d
```

3) Set:

- `OPENAI_BASE_URL=http://litellm:4000/v1`
- `OPENAI_MODEL` to one of the `model_name` entries in `services/litellm/config.yaml`

## Config

- `services/litellm/config.yaml`

