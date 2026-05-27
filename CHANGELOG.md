# Changelog

## [1.0.0] - 2026-05-26

Initial release. Google Slides MCP server providing read, template-fill, and edit
access to Google Slides presentations for authenticated users. Deployed on Google
Cloud Run with per-user Google OAuth passthrough and domain restriction.

### Tools (11)

**Read (4):** `get_presentation` (outline + object IDs), `get_presentation_text`
(text + speaker notes as markdown), `export_presentation_pdf`, `get_slide_thumbnail`.

**Write (7):** `duplicate_presentation` (template copy, stays private),
`replace_all_text` (placeholder templating, up to 100 replacements),
`update_table_cells` (up to 200 cells), `insert_image`, `replace_image`,
`embed_sheets_chart` (linked chart from a Google Sheet), `refresh_sheets_charts`.

### Architecture

- Express + `StreamableHTTPServerTransport` (stateless, per-request `McpServer`)
- Per-user Google OAuth passthrough — every API call runs as the requesting user
- Token validation via Google's `tokeninfo` endpoint with SHA-256-keyed cache
- RFC 8414 + RFC 7591 for automated Claude.ai OAuth discovery and registration
- Docker multi-stage build → GCP Container Registry → Cloud Run

### Security

- Google OAuth domain check on every request; audience claim validated against
  the configured OAuth client ID
- Per-user OAuth passthrough — Google enforces each user's own Drive/Slides ACLs
- No sharing / permission-mutation tool; `duplicate_presentation` copies with
  default (private) permissions and never calls the Drive Permissions API
- Structured audit log: `event:"usage"` per request + `event:"write"` per
  mutation (objectsModified, presentationId, outcome)
- Bulk-operation Slack DM when a single call modifies more than `BULK_OP_THRESHOLD`
  objects (default: 20)
- 60 req/min per-user rate limit; `/register` origin check + 10/min global limit
- `npm audit --audit-level=high` build gate in Cloud Build pipeline
- Non-root Docker container user

### Tests

20 unit tests (`node:test`) covering pure transform functions (outline/text/notes
extraction, chart discovery, all batchUpdate request builders) and audit threshold
and alert-text logic.
