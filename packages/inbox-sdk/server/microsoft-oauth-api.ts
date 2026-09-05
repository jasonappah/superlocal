import { InboxError } from '../src/contracts'
import type { InboxApiOptions } from '../src/http'
import type { createMicrosoftOAuthHost } from './microsoft-oauth'

const opaque = /^[^\x00-\x1f\x7f]{1,4096}$/

function problem(error: unknown): Response {
  const known = error instanceof InboxError
  const status = known && error.status >= 400 && error.status <= 599 ? error.status : 500
  const code = known && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
  const message = status === 401 ? 'Authentication required' : status === 404 ? 'Not found' : status === 400 ? 'Invalid request' : 'Request failed'
  return Response.json({ code, error: message }, { status, headers: { 'cache-control': 'no-store' } })
}

/** Small public OAuth surface. Start/status stay on the authenticated host API; only a one-use handoff and callback arrive here. */
export function createMicrosoftOAuthApi(options: { oauth: () => ReturnType<typeof createMicrosoftOAuthHost>; authenticate: InboxApiOptions['authenticate'] }) {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const authorize = /^\/v1\/oauth\/microsoft\/authorize\/([A-Za-z0-9-]{1,128})$/.exec(url.pathname)
        if (authorize && request.method === 'GET') {
          if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('ticket').length !== 1) throw new InboxError('INVALID_QUERY', 'Invalid request', 400)
          const ticket = url.searchParams.get('ticket')!
          if (!opaque.test(ticket)) throw new InboxError('INVALID_QUERY', 'Invalid request', 400)
          const handoff = await options.oauth().authorize(authorize[1]!, ticket)
          return new Response(null, { status: 302, headers: { Location: handoff.location, 'Set-Cookie': handoff.setCookie, 'Cache-Control': 'no-store' } })
        }
        if (url.pathname === '/v1/oauth/microsoft/callback' && request.method === 'GET') {
          const owner = await options.authenticate(request)
          if (!owner) throw new InboxError('UNAUTHENTICATED', 'Authentication required', 401)
          const result = await options.oauth().complete(request.url, request.headers.get('cookie') ?? '', owner.id)
          return Response.json(result.connection, { headers: { 'Set-Cookie': result.setCookie, 'Cache-Control': 'no-store' } })
        }
        throw new InboxError('NOT_FOUND', 'Not found', 404)
      } catch (error) { return problem(error) }
    },
  }
}
