# google-slides-mcp

> A Model Context Protocol (MCP) server for Google Slides — read, template-fill, and edit presentations — deployed on Google Cloud Run with per-user Google OAuth.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%3E%3D22-339933?logo=node.js&logoColor=white)

---

## Overview

`google-slides-mcp` exposes 11 MCP tools that let an authenticated user read, duplicate, and edit Google Slides presentations directly from an MCP client such as Claude.ai.

Key design choices:

- **Per-user OAuth passthrough** — every Slides and Drive API call runs as the authenticated user. Google enforces their existing Drive permissions on every operation; the server never accesses files the user cannot already see.
- **Domain restriction** — only accounts with an `@example.com` email address (configurable via `ALLOWED_DOMAIN`) can connect.
- **No permission-mutation surface** — there is deliberately no tool to share, transfer ownership of, or otherwise widen access to a presentation.
- **Structured audit log + bulk-op alerting** — every write is logged to Cloud Logging; operations that modify more objects than `BULK_OP_THRESHOLD` in a single call send a Slack DM to a configurable alert user.

---

## MCP Tools

### Read tools (4)

| Tool | Description |
|---|---|
| `get_presentation` | Return the presentation outline: title, slide count, and every element's `objectId`, kind (`shape`/`table`/`image`/`sheetsChart`), and text. Use this first to find object IDs for edit tools. |
| `get_presentation_text` | Extract all slide text and speaker notes as markdown (one section per slide). |
| `export_presentation_pdf` | Export the entire deck as a PDF, returned as a downloadable MCP resource (≤8 MB inline). |
| `get_slide_thumbnail` | Generate a PNG thumbnail for a single slide and return its temporary URL. Sizes: `SMALL` / `MEDIUM` / `LARGE`. |

### Write tools (7)

| Tool | Description |
|---|---|
| `duplicate_presentation` | Copy a template presentation to a new private file (no sharing inherited). The starting point for any templating workflow. |
| `replace_all_text` | Find-and-replace placeholder text across a deck (e.g. `{{account_name}}` → `Acme`). Up to 100 replacements per call; optionally scoped to specific slides. |
| `update_table_cells` | Overwrite specific table cells by zero-based row/column index. Up to 200 cells per call. |
| `insert_image` | Add an image to a slide from a public URL, with configurable size and position (points). |
| `replace_image` | Swap an existing image in place with a new URL (e.g. update a logo). |
| `embed_sheets_chart` | Embed a chart from a Google Sheet as a **linked** chart so it can later be refreshed. |
| `refresh_sheets_charts` | Re-pull every linked Sheets chart in the deck to reflect the latest Sheet data. |

---

## Architecture

```
Claude.ai (MCP client)
        │  HTTPS + Bearer token
        ▼
  Express server  ──  /health, /.well-known/oauth-*, /register, /mcp
        │
  ┌─────┴─────────────────────────────────┐
  │  per-request pipeline                 │
  │  1. verifyGoogleToken (tokeninfo API) │
  │  2. per-user rate limiter (60 req/min)│
  │  3. McpServer (stateless, per-request)│
  │  4. SlidesClient (user's OAuth token) │
  └──────────────────────────────────────┘
        │
  Google Slides / Drive APIs
```

**Transport:** `StreamableHTTPServerTransport` (stateless — a fresh `McpServer` is created for every request). Responds on both `/` and `/mcp`.

**Auth flow:**
1. Claude.ai calls `/.well-known/oauth-authorization-server` to discover the Google OAuth endpoints.
2. Claude.ai calls `/register` (RFC 7591 Dynamic Client Registration) to obtain the Google OAuth client credentials, then redirects the user through the standard Google sign-in flow.
3. On each MCP request, the server validates the Google OAuth bearer token via Google's `tokeninfo` endpoint, confirms the email domain, and checks the audience claim.
4. Token validation results are cached (SHA-256 keyed, 60-second TTL, 500-entry LRU cap) to avoid a Google roundtrip on every call.

**Google OAuth scopes:** `openid email profile presentations drive`
Full `drive` is required because the templating workflow copies pre-existing user templates (`drive.file` cannot see files the app did not create). Narrowing to `drive.readonly` + `drive.file` is a documented follow-up (needs verification that `files.copy` works with those scopes).

**Audit + alerting:**
- Every write tool is wrapped with `audited()` which emits a structured Cloud Logging entry (`event: "write"`) with `userEmail`, `tool`, `objectsModified`, `presentationId`, `outcome`, and `durationMs`.
- When a single successful call modifies more than `BULK_OP_THRESHOLD` objects (default: 20), the server fires a Slack DM to `BULK_OP_ALERT_USER_ID` via `chat.postMessage` (fire-and-forget, no impact on user-facing latency).

**Rate limiting:** 60 requests/minute per user (in-memory, fixed-window). The `/register` endpoint is additionally limited to 10 calls/minute globally.

**Deployment:** Docker multi-stage build → Google Container Registry → Cloud Run (`us-central1`). Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SLACK_BOT_TOKEN`) are pulled from GCP Secret Manager at runtime. The Cloud Build pipeline (`cloudbuild.yaml`) runs `npm audit --audit-level=high` as a build gate before building or pushing the image.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.x, Node.js ≥ 22 |
| MCP SDK | `@modelcontextprotocol/sdk` (StreamableHTTP transport) |
| HTTP server | Express 5 |
| Google APIs | `googleapis` + `google-auth-library` |
| Input validation | Zod 4 |
| Containerization | Docker (multi-stage, non-root user) |
| CI/CD | Google Cloud Build → Cloud Run |
| Secrets | GCP Secret Manager |
| Testing | `node:test` (built-in, no test framework dependency) |

---

## Getting Started

### Prerequisites

- Node.js ≥ 22
- A Google Cloud project with the Slides and Drive APIs enabled
- A Google OAuth 2.0 client (Web application type), with `https://claude.ai/api/mcp/auth_callback` added as an authorized redirect URI
- (Optional) A Slack bot token with `chat:write` scope for bulk-operation alerting

### Install

```bash
git clone https://github.com/micahyee415/google-slides-mcp-server
cd google-slides-mcp-server
npm install
npm run build
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `PORT` | HTTP listen port (default: `8080`) |
| `ALLOWED_DOMAIN` | Email domain to restrict access to (default: `example.com`) |
| `SERVER_URL` | Public base URL of the server — used in OAuth metadata responses |
| `BULK_OP_THRESHOLD` | Object-count threshold that triggers a Slack DM (default: `20`) |
| `BULK_OP_ALERT_USER_ID` | Slack user ID to DM on bulk operations |
| `SLACK_BOT_TOKEN` | Slack bot token (`chat:write` scope) |

### Run locally

```bash
npm run dev
# Server listens on http://localhost:8080
# Health check: http://localhost:8080/health
```

### Deploy to Cloud Run

**One-time setup:**

```bash
# Enable required APIs
gcloud services enable slides.googleapis.com drive.googleapis.com \
  --project your-gcp-project

# Store secrets in Secret Manager
echo -n "your-client-id"     | gcloud secrets create slides-oauth-id     --data-file=- --project your-gcp-project
echo -n "your-client-secret" | gcloud secrets create slides-oauth-secret  --data-file=- --project your-gcp-project
echo -n "xoxb-..."           | gcloud secrets create slack-bot-token      --data-file=- --project your-gcp-project
```

**Build and deploy:**

```bash
gcloud builds submit --config cloudbuild.yaml \
  --project your-gcp-project \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# Cloud Run resets IAM on deploy — restore public invoker:
gcloud run services add-iam-policy-binding google-slides-mcp \
  --member=allUsers --role=roles/run.invoker \
  --region us-central1 --project your-gcp-project

# Verify
curl https://your-service.example.com/health
```

Update `SERVER_URL` in `service.yaml` (and in GCP) to your actual Cloud Run service URL after the first deploy.

---

## Connecting an MCP Client

Point your MCP client at your service URL. For Claude.ai:

1. Go to **Settings → Integrations → Add integration**
2. Enter the MCP server URL: `https://your-service.example.com/mcp`
3. Authenticate with your `@example.com` Google account when prompted

The server implements RFC 8414 (OAuth Authorization Server Metadata) and RFC 7591 (Dynamic Client Registration), so Claude.ai's OAuth flow is fully automated.

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

Key security properties:

- **Domain restriction** — `ALLOWED_DOMAIN` limits access to a single Google Workspace organization
- **Audience check** — the Google OAuth token's `aud` claim is validated against `GOOGLE_CLIENT_ID` to prevent token reuse from other apps
- **Per-user isolation** — no service account; every API call runs under the authenticated user's own Google permissions
- **No permission escalation** — there is no tool that can share, copy with sharing, or transfer ownership of a presentation
- **Structured audit trail** — every write is logged with user, tool, objects modified, and outcome
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Cache-Control: no-store` on all responses
- **Build gate** — `npm audit --audit-level=high` must pass before a container image is built or pushed
- **Non-root container** — the Docker image runs as a dedicated non-root user

---

## License

No license file is present in this repository. All rights reserved unless otherwise stated.
