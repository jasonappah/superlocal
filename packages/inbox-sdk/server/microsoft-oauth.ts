import type { Database } from 'bun:sqlite'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import * as oidc from 'openid-client'
import { InboxError, type Connection, type ConnectionIdentity, type Inbox } from '../src/contracts'
import { createCredentialCrypto } from './crypto'

export interface MicrosoftOAuthConfig {
  clientId: string
  redirectUri: string
  scopes: string[]
}

export interface MicrosoftOAuthAttempt {
  id: string
  providerId: 'exchange-imap'
  status: 'pending' | 'authorizing' | 'exchanging' | 'completed' | 'failed'
  expiresAt: string
  connectionId: string | null
  authorizeUrl?: string
}

type AttemptRow = {
  id: string; owner: string; registration: string; status: MicrosoftOAuthAttempt['status']; expires_at: number
  reconnect_connection_id: string | null; connection_id: string | null; secrets: string | null
  ticket_hash: string | null; state_hash: string | null; binding_hash: string | null
}
type AttemptSecrets = { verifier: string; state: string; handoff?: string; email: string; identity: ConnectionIdentity | null; generation?: number }

const callbackPath = '/'
const authorizationEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const tokenEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const issuer = 'https://login.microsoftonline.com/common/v2.0'
const lifetime = 10 * 60_000
const token = /^[A-Za-z0-9_-]{43}$/
const email = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const scopeToken = /^[\x21\x23-\x5b\x5d-\x7e]+$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
const fail = () => new InboxError('OAUTH_FAILED', 'The Microsoft 365 connection attempt could not be completed.', 400)

export function createMicrosoftOAuthCoordinator(options: {
  database: Database; config: MicrosoftOAuthConfig; now: () => number; fetch?: typeof globalThis.fetch
  encrypt: (plaintext: string, owner: string, id: string) => string; decrypt: (ciphertext: string, owner: string, id: string) => string
  finish: (owner: string, credentials: Record<string, unknown>, identity: ConnectionIdentity, reconnectConnectionId?: string, expectedGeneration?: number) => Promise<Connection>
  checkConnection: (owner: string, id: string) => Promise<Connection>
  listConnections: (owner: string) => Promise<Connection[]>
}) {
  const { database: db, now, encrypt, decrypt, finish, checkConnection, listConnections } = options
  const transport = options.fetch ?? globalThis.fetch
  let redirect: URL
  let scopes: string[]
  try {
    if (!bounded(options.config.clientId, 1024) || !bounded(options.config.redirectUri, 2048)) throw fail()
    redirect = new URL(options.config.redirectUri)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    if (redirect.href !== options.config.redirectUri || redirect.pathname !== callbackPath || redirect.username || redirect.password || redirect.search || redirect.hash ||
      (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback))) throw fail()
    if (!Array.isArray(options.config.scopes) || options.config.scopes.length > 64 || options.config.scopes.some(scope => !bounded(scope, 2048) || !scopeToken.test(scope)) ||
      !options.config.scopes.includes('https://outlook.office.com/IMAP.AccessAsUser.All') || !options.config.scopes.includes('https://outlook.office.com/SMTP.Send') ||
      !options.config.scopes.includes('offline_access')) throw fail()
    scopes = [...new Set(options.config.scopes)]
  } catch { throw new InboxError('VALIDATION', 'Microsoft 365 OAuth requires a valid public client registration, root loopback callback, and IMAP, SMTP, and offline_access scopes.') }
  const registration = hash(JSON.stringify([options.config.clientId, options.config.redirectUri, scopes]))
  const baseUrl = redirect.origin

  db.exec(`CREATE TABLE IF NOT EXISTS sdk_oauth_attempts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, registration TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL,
    reconnect_connection_id TEXT, connection_id TEXT, secrets TEXT, ticket_hash TEXT UNIQUE, state_hash TEXT UNIQUE, binding_hash TEXT, failure TEXT
  ); CREATE INDEX IF NOT EXISTS sdk_oauth_attempt_expiry ON sdk_oauth_attempts(status,expires_at);`)
  const expire = () => db.query(`UPDATE sdk_oauth_attempts SET status='failed', secrets=NULL, ticket_hash=NULL, state_hash=NULL, binding_hash=NULL
    WHERE expires_at<=? AND status IN ('pending','authorizing','exchanging')`).run(now())
  const consume = (id: string) => { try { db.query(`UPDATE sdk_oauth_attempts SET status='failed', secrets=NULL, ticket_hash=NULL, state_hash=NULL, binding_hash=NULL
    WHERE id=? AND status IN ('pending','authorizing','exchanging')`).run(id) } catch {} }
  const cookie = (id: string, value: string, age: number) => `inbox_microsoft_oauth_${id}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}` +
    (redirect.protocol === 'https:' ? '; Secure' : '') + (age === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '')
  const secretsFor = (row: AttemptRow): AttemptSecrets => {
    if (!row.secrets || row.registration !== registration) throw fail()
    const value = JSON.parse(decrypt(row.secrets, row.owner, row.id)) as AttemptSecrets
    if (!value || !token.test(value.verifier) || !token.test(value.state) || !email.test(value.email)) throw fail()
    return value
  }
  const ownerId = (owner: string) => { if (!bounded(owner, 1024)) throw new InboxError('UNAUTHORIZED', 'Authentication is required.', 401) }

  return {
    async start(owner: string, input: { email: string; connectionId?: string }) {
      ownerId(owner)
      if (!input || typeof input !== 'object' || !bounded(input.email, 320) || !email.test(input.email) ||
        (input.connectionId !== undefined && !bounded(input.connectionId, 255))) throw new InboxError('VALIDATION', 'Enter a valid Microsoft 365 mailbox email.', 400)
      const address = input.email.toLowerCase()
      let identity: ConnectionIdentity | null = null
      let generation: number | undefined
      if (input.connectionId) {
        const connection = await checkConnection(owner, input.connectionId)
        if (connection.providerId !== 'exchange-imap' || !connection.identity || connection.identity.issuer !== issuer || connection.identity.subject !== address || connection.identity.registrationId !== options.config.clientId) {
          throw new InboxError('VALIDATION', 'This connection cannot be reconnected with this Microsoft 365 registration.', 409)
        }
        identity = { ...connection.identity }; generation = connection.generation
      }
      try {
        expire()
        const id = randomUUID(), handoff = oidc.randomState(), state = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), expiresAt = now() + lifetime
        const secrets: AttemptSecrets = { verifier, state, handoff, email: address, identity, ...(generation === undefined ? {} : { generation }) }
        db.query(`INSERT INTO sdk_oauth_attempts (id,owner,registration,status,expires_at,reconnect_connection_id,secrets,ticket_hash,state_hash)
          VALUES (?,?,?,'pending',?,?,?,?,?)`).run(id, owner, registration, expiresAt, input.connectionId ?? null, encrypt(JSON.stringify(secrets), owner, id), hash(handoff), hash(state))
        return { id, providerId: 'exchange-imap' as const, status: 'pending' as const, expiresAt: new Date(expiresAt).toISOString(), connectionId: null,
          authorizeUrl: `${baseUrl}/v1/oauth/microsoft/authorize/${id}?ticket=${handoff}` }
      } catch { throw fail() }
    },
    async attempt(owner: string, id: string) {
      ownerId(owner); if (!bounded(id, 128)) throw new InboxError('NOT_FOUND', 'OAuth attempt not found.', 404)
      expire(); const row = db.query<AttemptRow, [string, string]>('SELECT * FROM sdk_oauth_attempts WHERE owner=? AND id=?').get(owner, id)
      if (!row) throw new InboxError('NOT_FOUND', 'OAuth attempt not found.', 404)
      return { id: row.id, providerId: 'exchange-imap' as const, status: row.status, expiresAt: new Date(row.expires_at).toISOString(), connectionId: row.connection_id }
    },
    async authorize(id: string, ticket: string) {
      let claimed: AttemptRow | null = null
      try {
        if (!bounded(id, 128) || !token.test(ticket)) throw fail(); expire()
        const binding = oidc.randomState()
        claimed = db.query<AttemptRow, [string, string, string, string, number]>(`UPDATE sdk_oauth_attempts SET status='authorizing', ticket_hash=NULL, binding_hash=?
          WHERE id=? AND registration=? AND ticket_hash=? AND status='pending' AND expires_at>? RETURNING *`).get(hash(binding), id, registration, hash(ticket), now())
        if (!claimed) throw fail(); const secrets = secretsFor(claimed); if (secrets.handoff !== ticket) throw fail(); delete secrets.handoff
        db.query("UPDATE sdk_oauth_attempts SET secrets=? WHERE id=? AND status='authorizing'").run(encrypt(JSON.stringify(secrets), claimed.owner, claimed.id), claimed.id)
        const query = new URLSearchParams({ client_id: options.config.clientId, response_type: 'code', response_mode: 'query', redirect_uri: options.config.redirectUri,
          scope: scopes.join(' '), state: secrets.state, code_challenge: await oidc.calculatePKCECodeChallenge(secrets.verifier), code_challenge_method: 'S256', prompt: 'select_account' })
        return { location: `${authorizationEndpoint}?${query}`, setCookie: cookie(claimed.id, binding, Math.ceil((claimed.expires_at - now()) / 1000)) }
      } catch { if (claimed) consume(claimed.id); throw fail() }
    },
    async complete(callbackUrl: string, cookieHeader: string, currentOwner?: string) {
      let claimed: AttemptRow | null = null
      try {
        if (!bounded(callbackUrl, 16_384) || callbackUrl.includes('#') || callbackUrl.slice(0, callbackUrl.indexOf('?')) !== options.config.redirectUri) throw fail()
        const callback = new URL(callbackUrl), state = callback.searchParams.get('state')
        if (callback.origin !== redirect.origin || callback.pathname !== '/' || callback.searchParams.getAll('state').length !== 1 || !state || !token.test(state)) throw fail()
        expire(); const row = db.query<AttemptRow, [string, string]>("SELECT * FROM sdk_oauth_attempts WHERE state_hash=? AND registration=? AND status='authorizing'").get(hash(state), registration)
        if (!row) throw fail()
        if (db.query("UPDATE sdk_oauth_attempts SET status='exchanging', secrets=NULL, ticket_hash=NULL, state_hash=NULL, binding_hash=NULL WHERE id=? AND state_hash=? AND status='authorizing' AND expires_at>?").run(row.id, hash(state), now()).changes !== 1) throw fail()
        claimed = row
        if (currentOwner !== undefined && (!bounded(currentOwner, 1024) || currentOwner !== row.owner)) throw fail()
        if (typeof cookieHeader !== 'string' || cookieHeader.length > 16_384 || /[\x00-\x1f\x7f]/.test(cookieHeader)) throw fail()
        const name = `inbox_microsoft_oauth_${row.id}`, bindings = cookieHeader.split(';').map(item => item.trim()).filter(item => item.split('=', 1)[0] === name), binding = bindings[0]?.slice(name.length + 1)
        if (bindings.length !== 1 || !binding || !token.test(binding) || !row.binding_hash || !timingSafeEqual(Buffer.from(hash(binding), 'hex'), Buffer.from(row.binding_hash, 'hex'))) throw fail()
        const seen = new Set<string>(); for (const [key, value] of callback.searchParams) { if (seen.has(key) || seen.size >= 32 || !bounded(key, 128) || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw fail(); seen.add(key) }
        const secrets = secretsFor(row); if (secrets.state !== state || callback.searchParams.has('error') || !bounded(callback.searchParams.get('code'), 8192)) throw fail()
        const response = await transport(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.config.clientId, grant_type: 'authorization_code', code: callback.searchParams.get('code')!, redirect_uri: options.config.redirectUri, code_verifier: secrets.verifier }) })
        const result = await response.json().catch(() => null) as { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown } | null
        if (!response.ok || !result || !bounded(result.access_token, 16_384) || !bounded(result.refresh_token, 16_384) || String(result.token_type).toLowerCase() !== 'bearer' || !Number.isInteger(result.expires_in) || Number(result.expires_in) < 1 ||
          result.scope !== undefined && !bounded(result.scope, 8192)) throw fail()
        const granted = result.scope === undefined ? scopes : result.scope.split(' ')
        if (!scopes.every(scope => granted.includes(scope))) throw fail()
        const identity: ConnectionIdentity = { issuer, subject: secrets.email, registrationId: options.config.clientId }
        if (row.reconnect_connection_id) {
          const target = await checkConnection(row.owner, row.reconnect_connection_id)
          if (!secrets.identity || JSON.stringify(secrets.identity) !== JSON.stringify(identity) || target.providerId !== 'exchange-imap' || JSON.stringify(target.identity) !== JSON.stringify(identity) || target.generation !== secrets.generation) throw fail()
        } else if ((await listConnections(row.owner)).some(connection => connection.providerId === 'exchange-imap' && JSON.stringify(connection.identity) === JSON.stringify(identity))) throw fail()
        const expiresAt = new Date(now() + Number(result.expires_in) * 1000).toISOString()
        const connection = await finish(row.owner, { email: secrets.email, clientId: options.config.clientId, accessToken: result.access_token,
          refreshToken: result.refresh_token, expiresAt, scopes: granted }, identity, row.reconnect_connection_id ?? undefined, secrets.generation)
        db.query("UPDATE sdk_oauth_attempts SET status='completed', connection_id=? WHERE id=?").run(connection.id, row.id)
        return { connection, setCookie: cookie(row.id, '', 0) }
      } catch { if (claimed) consume(claimed.id); throw fail() }
    },
  }
}

export function createMicrosoftOAuthHost(options: { inbox: Inbox; database: Database; encryptionKey: string; config: MicrosoftOAuthConfig; now?: () => number; fetch?: typeof globalThis.fetch }) {
  if (!options.inbox.providers().some(provider => provider.id === 'exchange-imap')) throw new InboxError('UNSUPPORTED_PROVIDER', 'The Microsoft 365 IMAP provider is not enabled.', 409)
  const crypto = createCredentialCrypto({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: options.encryptionKey })
  return createMicrosoftOAuthCoordinator({ database: options.database, config: options.config, now: options.now ?? Date.now, fetch: options.fetch, encrypt: crypto.encryptCredential, decrypt: crypto.decryptCredential,
    checkConnection: (owner, id) => options.inbox.connection(owner, id), listConnections: owner => options.inbox.connections(owner),
    finish: async (owner, credentials, identity, reconnectId, generation) => {
      if (!reconnectId) return options.inbox.createConnection(owner, { providerId: 'exchange-imap', credentials }, identity)
      const existing = await options.inbox.connection(owner, reconnectId)
      if (existing.providerId !== 'exchange-imap' || JSON.stringify(existing.identity) !== JSON.stringify(identity) || existing.sourceIds.length !== 1 || generation === undefined) throw new InboxError('ACCOUNT_MISMATCH', 'Reconnect must authorize the original Microsoft 365 mailbox.', 409)
      await options.inbox.reconnect(owner, existing.sourceIds[0]!, credentials, { identity, generation })
      return options.inbox.connection(owner, existing.id)
    },
  })
}
