import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { MOCK_OWNER } from '@superlocal/mock-api'
import { InboxError } from 'inbox-sdk'
import type { LocalConfig } from './config'

export type McpScope = 'read' | 'write'
export interface McpGrantView { id: string; name: string; scope: McpScope; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }
export interface McpGrantAuth { owner: string; scope: McpScope }

const TOKEN_PREFIX = 'superlocal_mcp_'
const TOKEN_BODY = '[A-Za-z0-9_-]{32}' // 24 random bytes in base64url.
const LAST_USED_INTERVAL_MS = 60_000
const safeHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

function problem(status: number, code: string, error: string): Response {
  return Response.json({ code, error, retryable: status >= 500 }, { status, headers: safeHeaders })
}

export interface McpGrants {
  /** The single owner every stored grant must belong to. */
  owner: string
  /** Returns the plaintext token exactly once; only its sha256 hash is stored. */
  create(owner: string, name: string, scope: McpScope): { id: string; token: string }
  /** Listing and revocation never expose tokens. */
  list(): McpGrantView[]
  revoke(id: string): boolean
  authenticate(token: string): Promise<McpGrantAuth | undefined>
}

/**
 * Durable per-instance MCP bearer grants on the host ledger. Grant rows live beside
 * the instance identity proof, so a different installation never recognizes them and
 * the host close path keeps them (nothing here drops tables).
 */
export function createMcpGrants(config: LocalConfig, runtime: { database: Database }): McpGrants {
  const owner = config.mode === 'mock' ? MOCK_OWNER : `local:${config.instanceId}`
  runtime.database.exec('CREATE TABLE IF NOT EXISTS local_mcp_grants (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER) STRICT')
  type Row = { id: string; owner: string; name: string; scope: string; token_hash: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
  const row = (value: Row): McpGrantView => ({
    id: value.id, name: value.name,
    scope: ['read', 'write'].includes(value.scope) ? value.scope as McpScope : 'read',
    createdAt: value.created_at, lastUsedAt: value.last_used_at, revokedAt: value.revoked_at,
  })

  function create(creator: string, rawName: string, scope: McpScope): { id: string; token: string } {
    if (config.auth.method !== 'loopback') throw new InboxError('MCP_AUTH_UNSUPPORTED', 'MCP grants require a loopback-authenticated profile.', 403)
    if (creator !== owner) throw new InboxError('MCP_OWNER_MISMATCH', 'MCP grants are created for this installation\'s single owner only.', 400)
    if (typeof rawName !== 'string') throw new InboxError('MCP_NAME_INVALID', 'A grant name between 1 and 80 visible characters is required.', 400)
    const name = rawName.trim()
    if (!name || name.length > 80 || /[\x00-\x1f\u007f]/.test(name)) throw new InboxError('MCP_NAME_INVALID', 'A grant name between 1 and 80 visible characters is required.', 400)
    if (scope !== 'read' && scope !== 'write') throw new InboxError('MCP_SCOPE_INVALID', 'A grant scope must be read or write.', 400)
    const id = `mcp_${randomBytes(8).toString('hex')}`
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    try {
      runtime.database.query('INSERT INTO local_mcp_grants (id, owner, name, scope, token_hash, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, owner, name, scope, tokenHash, Date.now())
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new InboxError('MCP_NAME_EXISTS', 'A grant with that name already exists.', 409)
      throw new InboxError('MCP_GRANT_STORE_FAILED', 'The MCP grant could not be stored.', 500)
    }
    return { id, token }
  }

  function list(): McpGrantView[] {
    return runtime.database.query<Row, []>('SELECT * FROM local_mcp_grants ORDER BY created_at, id').all().map(row)
  }

  function revoke(id: string): boolean {
    if (typeof id !== 'string' || !/^mcp_[0-9a-f]{16}$/.test(id)) return false
    const value = runtime.database.query('SELECT revoked_at IS NULL AS active FROM local_mcp_grants WHERE id=?').get(id) as { active: number } | null
    if (!value) return false
    if (!value.active) return true
    runtime.database.query('UPDATE local_mcp_grants SET revoked_at=? WHERE id=?').run(Date.now(), id)
    return true
  }

  async function authenticate(token: string): Promise<McpGrantAuth | undefined> {
    if (config.auth.method !== 'loopback') return undefined
    if (typeof token !== 'string' || token.length !== TOKEN_PREFIX.length + 32 || !token.startsWith(TOKEN_PREFIX) ||
      !new RegExp(`^${TOKEN_PREFIX}${TOKEN_BODY}$`).test(token)) return undefined
    const hash = createHash('sha256').update(token).digest('hex')
    // Hash lookup bounds the scan; the digest comparison is still constant time.
    const value = runtime.database.query<Row, [string]>('SELECT * FROM local_mcp_grants WHERE token_hash=?').get(hash)
    // Fail closed on foreign rows: a grant created by another owner (or an earlier
    // installation mode sharing this store) never authenticates on this owner.
    if (!value || value.owner !== owner || value.token_hash.length !== hash.length) return undefined
    // Both sides decode from hex, so the digest comparison is constant time and cannot throw.
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(value.token_hash, 'hex')) || value.revoked_at !== null) return undefined
    const now = Date.now()
    // Throttle last-used writes: at most one update per grant per minute.
    if (value.last_used_at === null || now - value.last_used_at >= LAST_USED_INTERVAL_MS) {
      runtime.database.query('UPDATE local_mcp_grants SET last_used_at=? WHERE id=?').run(now, value.id)
    }
    return { owner: value.owner, scope: value.scope === 'write' ? 'write' : 'read' }
  }

  return { owner, create, list, revoke, authenticate }
}

/** Which exact SDK operations an MCP grant may reach. Read scopes see only read entries. */
const MCP_ROUTES: Array<{ method: string; path: RegExp; scope: McpScope }> = [
  { method: 'GET', path: /^\/v1\/accounts$/, scope: 'read' },
  { method: 'GET', path: /^\/v1\/mailboxes$/, scope: 'read' },
  { method: 'GET', path: /^\/v1\/mailboxes\/([^/%]+)$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/mailbox-conversations$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/mailbox-message-page$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/mailbox-counts$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/mailbox-sync\/status$/, scope: 'read' },
  { method: 'GET', path: /^\/v1\/mailbox-actions\/([^/%]+)$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/mailbox-actions$/, scope: 'write' },
  { method: 'POST', path: /^\/v1\/mailbox-actions\/([^/%]+)\/undo$/, scope: 'write' },
  { method: 'GET', path: /^\/v1\/drafts$/, scope: 'read' },
  { method: 'GET', path: /^\/v1\/drafts\/([^/%]+)$/, scope: 'read' },
  { method: 'POST', path: /^\/v1\/drafts$/, scope: 'write' },
  { method: 'PATCH', path: /^\/v1\/drafts\/([^/%]+)$/, scope: 'write' }, // SDK update mapping; conditional via If-Match.
  { method: 'DELETE', path: /^\/v1\/drafts\/([^/%]+)$/, scope: 'write' },
  { method: 'POST', path: /^\/v1\/drafts\/([^/%]+)\/submit$/, scope: 'write' },
  // Operation status reads let MCP clients resolve queued and uncertain sends.
  { method: 'GET', path: /^\/v1\/operations\/([^/%]+)$/, scope: 'read' },
]

export interface McpMountOptions {
  grants: McpGrants
  /** The grant-authenticated Inbox API the mount forwards allowlisted calls to. */
  api: { fetch(request: Request): Response | Promise<Response> }
  /** Encoded JSON request bodies forwarded to the API stay under this byte limit. */
  bodyLimitBytes?: number
  /** Encoded results streamed back to the MCP client stay under this byte limit. */
  resultLimitBytes?: number
}

export interface McpMount { fetch(request: Request): Promise<Response | undefined> }

const DEFAULT_BODY_LIMIT = 256 * 1024
const DEFAULT_RESULT_LIMIT = 2 * 1024 * 1024

/**
 * Bearer-gated MCP mount. Only `Authorization: Bearer superlocal_mcp_*` requests are
 * handled; every other request returns undefined so normal host dispatch continues.
 * The mounted API never sees browser cookies and browser identities never see it.
 */
export function createMcpMount(options: McpMountOptions): McpMount {
  const bodyLimit = Math.max(1, Math.floor(options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT))
  const resultLimit = Math.max(1, Math.floor(options.resultLimitBytes ?? DEFAULT_RESULT_LIMIT))
  const oversized = (status: number, code: string, message: string) => problem(status, code, message)

  async function boundedRequest(request: Request): Promise<Request> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > bodyLimit)) {
      throw new InboxError('MCP_BODY_TOO_LARGE', 'The MCP request body exceeds its size limit.', 413)
    }
    if (request.headers.has('content-encoding')) {
      throw new InboxError('MCP_ENCODING_FORBIDDEN', 'Encoded MCP request bodies are not supported.', 415)
    }
    if (!request.body) return request
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > bodyLimit) { await reader.cancel().catch(() => {}); throw new InboxError('MCP_BODY_TOO_LARGE', 'The MCP request body exceeds its size limit.', 413) }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    if (size === 0) return request
    const buffered = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { buffered.set(chunk, offset); offset += chunk.byteLength }
    return new Request(request.url, { method: request.method, headers: request.headers, body: buffered, signal: request.signal })
  }

  async function boundedResponse(downstream: Response): Promise<Response> {
    const length = Number(downstream.headers.get('content-length') ?? '')
    if (downstream.headers.get('content-length') !== null && Number.isSafeInteger(length) && length > resultLimit) {
      await downstream.body?.cancel().catch(() => {})
      return oversized(503, 'MCP_RESULT_TOO_LARGE', 'The MCP result exceeded its size limit.')
    }
    if (downstream.body === null) return downstream
    const reader = downstream.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let exceeded = false
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > resultLimit) { exceeded = true; await reader.cancel().catch(() => {}); break }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    if (exceeded) return oversized(503, 'MCP_RESULT_TOO_LARGE', 'The MCP result exceeded its size limit.')
    // Mounted results and errors are never cacheable and never echo credentials.
    const headers = new Headers(downstream.headers)
    headers.set('Cache-Control', 'no-store')
    headers.delete('Content-Length')
    // One exact-size ArrayBuffer backs the response body: never a shared oversized view.
    const buffer = new ArrayBuffer(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    const bytes = new Uint8Array(buffer)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new Response(buffer, { status: downstream.status, statusText: downstream.statusText, headers })
  }

  return {
    async fetch(request: Request): Promise<Response | undefined> {
      const header = request.headers.get('authorization')
      if (!header?.startsWith(`Bearer ${TOKEN_PREFIX}`)) return undefined
      try {
        const grant = await options.grants.authenticate(header.slice(7))
        if (!grant) return oversized(401, 'MCP_GRANT_INVALID', 'The MCP grant token is invalid, revoked or belongs to another installation.')
        const url = new URL(request.url)
        // Exact raw-path matching: encoded or aliased paths never authorize an operation.
        const route = MCP_ROUTES.find(candidate => request.method === candidate.method && candidate.path.test(url.pathname))
        if (!route || grant.scope === 'read' && route.scope === 'write') {
          return oversized(403, 'MCP_OPERATION_FORBIDDEN', 'This MCP grant does not permit this operation.')
        }
        const forwarded = await boundedRequest(request)
        return await boundedResponse(await options.api.fetch(forwarded))
      } catch (error) {
        if (error instanceof InboxError && /^MCP_[A-Z_]+$/.test(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
          return problem(error.status, error.code, error.message)
        }
        return oversized(503, 'MCP_UNAVAILABLE', 'The MCP mount could not complete this request.')
      }
    },
  }
}
