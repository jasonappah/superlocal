# MCP access to your Superlocal mail

This installation can expose a small, permission-scoped slice of Superlocal mail
to local MCP clients (anything that speaks the Model Context Protocol over
stdio). Access is token-based, owner-bound to this specific installation,
loopback-only, and hot-revocable. It never grants access to message bodies,
attachments, or host administration.

## How grants work

The local host stores one grants ledger inside its own runtime database
(`<dataDir>/<mode>/host.sqlite`, table `local_mcp_grants`). Every grant is
bound to the installation's single owner — the offline seed owner in mock
demo builds, or `local:<instanceId>` in real use. A token created by one
installation does not exist on any other installation, rows created for a
different owner are refused at authentication time, and revocation takes
effect immediately on the next request.

MCP grants currently require a loopback-authenticated profile. Restricted
Google-auth profiles cannot create or use grants until owner eligibility can
be checked against the authenticated application's authorization policy.

A token looks like `superlocal_mcp_` plus 32 unpadded base64url characters
(24 random bytes). It is shown exactly once, at creation. Only a SHA-256
digest is stored, so a lost token cannot be recovered — revoke it and issue a
new one.

## Provisioning with the CLI

`apps/local-host/src/mcp-admin.ts` manages grants against the configured
instance. It reads the same `SUPERLOCAL_CONFIG` / `SUPERLOCAL_DATA_DIR`
environment variables the desktop app uses, so it always operates on the
database your app runs:

```sh
# Create a grant (token printed once):
bun --no-env-file apps/local-host/src/mcp-admin.ts grant --name "Assistant (read)" --json
bun --no-env-file apps/local-host/src/mcp-admin.ts grant --name "Assistant (write)" --write --json

# List existing grants (never reveals tokens):
bun --no-env-file apps/local-host/src/mcp-admin.ts list [--json]

# Revoke (denials are instant):
bun --no-env-file apps/local-host/src/mcp-admin.ts revoke mcp_<id>
```

Scopes are `read` (queries and reads only) or `write` (adds draft creation,
updates, submission, done/undo actions).

## Connecting an MCP client

Add an entry to your MCP client configuration. The grant token lives only in
your client environment file — the adapter takes no flags and parses no config
files:

```json
{
  "mcpServers": {
    "superlocal-mail": {
      "command": "bun",
      "args": ["--no-env-file", "/path/to/superlocal/apps/mcp/src/index.ts"],
      "env": {
        "SUPERLOCAL_URL": "http://127.0.0.1:8790",
        "SUPERLOCAL_MCP_TOKEN": "superlocal_mcp_…"
      }
    }
  }
}
```

- `SUPERLOCAL_URL` must be a loopback HTTP(S) origin pointing at your instance's
  API port (`http://127.0.0.1:8790` and `http://localhost:8790` are the defaults
  for API traffic). Non-loopback URLs are refused at startup.
- The adapter authenticates with only the grant token; it never sees or mediates
  browser sessions, cookies, or sign-in state.
- Diagnostics go to stderr; stdout carries the MCP protocol only.

## Tools

| Tool | Scope | Purpose |
| --- | --- | --- |
| `list_accounts` | read | Connected accounts, bounded summaries |
| `list_mailboxes` | read | Mailboxes attached to this installation |
| `list_recent` | read | Newest conversations per mailbox, bounded |
| `search_mail` | read | Search with bounded pagination (≤2 cursor pages) and explicit truncation |
| `read_thread` | read | Cached message summaries for one conversation (senders, previews ≤200 chars, membership revisions) |
| `create_draft` | write | Create a local draft |
| `update_draft` | write | Conditionally update a draft against its current revision |
| `send_draft` | write | Submit a draft revision under an idempotency key |
| `mark_done` | write | Apply done state with durable idempotency receipts |
| `undo_done` | write | Undo a done action by receipt id |

Message bodies, HTML, and attachments are never returned by any tool — bodies
are read in the Superlocal UI. Read tools return bounded snippets only.

## Bounds

Every adapter request and result is bounded by the host mount: request bodies
≤256 KiB, results ≤2 MiB, list sizes ≤50 items (≤500 done targets, ≤200
recipients, ≤2 search cursor pages), snippets clipped with explicit
`…Truncated` flags, and a single 30-second budget per tool call. A mount that
would exceed either byte bound fails closed instead of streaming.

## Error mapping

Tool failures never leak host internals; they map to stable kinds with guidance:

| Situation | Kind | Guidance returned |
| --- | --- | --- |
| Invalid/revoked/wrong-instance token | `grant_invalid` | Reprovision hint (new grant via the CLI) |
| Operation outside the grant's scope or allowlist | `forbidden` | Reprovision hint for a larger scope |
| Unknown tool or missing resource | `not_found` | — |
| Stale draft revision / changed payload same id / racing send keys | `conflict` | Re-read the resource and retry with its current revision |
| Draft sent but still in flight | `queued` (with note) | Check again before resending |
| Send attempted but the outcome is unconfirmed | `queued` with an uncertainty note | Check the Sent view or the operation before resending |
| Host unreachable, timeout, rate limit, 5xx | `unavailable` (retryable) | Retry later |
| Tool input rejected locally | `invalid_request` | Exact input requirement |

## Security and lifecycle

- Grants authenticate only this installation's inbound MCP traffic; the mount
  never accepts grant tokens on other host routes, and encoded/aliased request
  paths are denied rather than decoded.
- When the desktop host shuts down, the connected stdio adapter simply loses its
  connection and exits; the grants and receipts stay durable in the runtime
  ledger and the same idempotency keys still replay after the next startup — no
  duplicate sends are created by reconnecting.
- The adapter exits 0 on clean client EOF and reports startup problems (missing
  URL, non-loopback URL, missing/invalid token) on stderr with an exit code of 1.
- Not exposed via MCP: message bodies/HTML, attachments, provider credentials,
  OAuth onboarding, host configuration, mailbox sync controls, and anything the
  SDK itself calls an unsupported provider action (those surface as `conflict`,
  not re-implementation).
