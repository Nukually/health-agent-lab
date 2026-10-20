# Health Agent Lab

English | [简体中文](README.zh-CN.md)

A health-scenario AI agent example for sharing code and architecture. It demonstrates a Hono API, a React web client, SSE streaming, model-native tool calling, structured output, persistent conversations, optional vector memory, and feature flags.

**This is a technical demonstration, not a patient-facing medical service. Use fictional accounts and synthetic data.** The repository does not include real user data, knowledge-base corpora, commercial assets, cloud credentials, or a hosted service.

The code is licensed under [Apache-2.0](LICENSE). Its purpose as a technical demonstration does not impose additional restrictions on commercial use permitted by the license. Third-party dependencies retain their own licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).

## Project scope

- `packages/shared`: shared types, feature matrix, client contracts, and tool UI manifests.
- `packages/backend`: Hono API, agent loop, tools, conversations and profiles, and optional external integrations.
- `packages/frontend`: React web client, SSE handling, tool cards, and consent-flow examples.
- `scripts`: standalone test runner and pre-publication checks.

This edition excludes native app shells, push SDK binaries, enterprise deployment pipelines, operational reports, and historical database migrations. The included migration is a **fresh-database baseline** generated from the current schema; it cannot upgrade an existing database from another system. The web client's retained Native bridge protocol serves only as a capability-detection and compatibility example.

## Run locally

Verified with Node.js 26, pnpm 11.21.0, and Docker Desktop. Default ports avoid the commonly used ports 3000, 5432, and 5173.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env: provide your own LLM_API_KEY and set JWT_SECRET
# to an independently generated value from this command:
openssl rand -hex 32

docker compose up -d postgres
pnpm --filter @health-agent/shared build
pnpm db:migrate
pnpm dev
```

- Web client: <http://localhost:5174>
- API: <http://localhost:13010/health>
- PostgreSQL: `127.0.0.1:15433`, database `health_agent_lab`.
- For local sign-in, use the fictional phone identifier `13800000000`, request a verification code, then enter `123`. The fixed code is for local/development demonstrations only, not public authentication.
- Stop the frontend and backend with Ctrl+C in the terminal that started them. Stop this project's database with `docker compose stop postgres`. Stopping the container does not delete its data volume.

If a port is occupied, update the frontend/backend ports in `.env`, the database port in Compose, and `DATABASE_URL` as appropriate. Startup does not terminate processes belonging to other projects.

Without a model API key, you can still build, run tests, and explore the interface, but you will not receive real model responses. There is no fallback to a maintainer's credentials or shared service.

## Optional integrations and data flow

| Feature | Configuration and behavior |
| --- | --- |
| Model conversations | Use your own OpenAI-compatible API; questions and context are sent to that provider |
| User memory | pgvector and embeddings; automatic extraction and recall are disabled in the demo configuration |
| Medical literature search | Optional `MEDICAL_RAG_QUERY_URL`; no request is made when unset; this tool is not in the default active agent tool set |
| Doctor and educational content | Requires your own service endpoint and token; no default service |
| Images and OCR | Requires your own OSS configuration and model capabilities; no real images are included |
| Voice, push, and observability | Optional; requires your own provider credentials; Push and Langfuse are disabled by default |
| App downloads and marketing entries | Disabled by default; no installation packages or branded promotional assets are provided |

Running a public service is not this project's default mode. Operators need to define authentication, data retention, third-party recipients, and consent rules that match their deployment. The demo notices are not a substitute for operational service agreements. See [Data Handling Boundaries](docs/DATA_HANDLING.md).

## Validation

```bash
pnpm build
pnpm test
pnpm check:publication
```

The test runner uses synthetic environment variables and points database and model endpoints to an unavailable local port. It does not load the developer's `.env` or call real models. After adding migrations, run `pnpm db:migrate` against a separate empty database; the command verifies the schema table by table and column by column.

## Publishing and contributing

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and the [Release Checklist](docs/RELEASE_CHECKLIST.md). Some supporting documents are currently in Chinese. This repository's history begins with this edition's initial commit. Keep private workspaces, credentials, and real conversations out of commits, issues, and build attachments.
