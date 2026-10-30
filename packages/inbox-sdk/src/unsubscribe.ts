import { lookup } from 'node:dns/promises'
import type { UnsubscribeTargets } from './contracts'

const MAX_URL = 2048
const MAX_MAILTO = 1024

function header(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function httpsTarget(value: string): string | undefined {
  if (value.length > MAX_URL || /[\u0000-\u0020\u007f]/.test(value)) return
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) return
  if (privateHost(url.hostname)) return
  return url.href
}

function mailtoTarget(value: string): string | undefined {
  if (value.length > MAX_MAILTO || /[\u0000-\u001f\u007f]/.test(value)) return
  const match = /^mailto:([^?]+)(?:\?([^#]*))?$/i.exec(value.trim())
  if (!match) return
  const address = decodeURIComponent(match[1]!).trim()
  if (!/^[^\s@,<>]{1,320}@[^\s@,<>]{1,255}$/.test(address)) return
  const subject = new URLSearchParams(match[2] ?? '').get('subject')?.trim()
  return `mailto:${address}${subject ? `?subject=${encodeURIComponent(subject.slice(0, 200))}` : ''}`
}

export function mailtoRecipient(target: string): { address: string; subject?: string } | undefined {
  const value = mailtoTarget(target)
  if (!value) return
  const match = /^mailto:([^?]+)(?:\?subject=(.*))?$/i.exec(value)!
  return { address: match[1]!, ...(match[2] ? { subject: decodeURIComponent(match[2]) } : {}) }
}

/**
 * Extract the bounded, actionable targets a bulk sender advertises. This is
 * evidence, not a decision: nothing is fetched here and no body is parsed.
 * RFC 2369 lists may carry both an HTTPS endpoint and a mailto fallback;
 * RFC 8058 one-click requires an HTTPS target plus the matching POST header.
 */
export function unsubscribeTargets(headers: Readonly<Record<string, string>> | undefined): UnsubscribeTargets | undefined {
  if (!headers) return
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const list = header(values.get('list-unsubscribe'))
  const urls = [...list.matchAll(/<([^<>]{1,2048})>/g)].map(match => match[1]!.trim())
  let https: string | undefined, mailto: string | undefined
  for (const value of urls) {
    if (!https && /^https:/i.test(value)) https = httpsTarget(value)
    if (!mailto && /^mailto:/i.test(value)) mailto = mailtoTarget(value)
    if (https && mailto) break
  }
  if (!https && !mailto) return
  const post = header(values.get('list-unsubscribe-post'))
  const oneClick = https && /(?:^|[;,\s])list-unsubscribe\s*=\s*one-click(?:$|[;,\s])/i.test(post) ? https : undefined
  return { version: 1, ...(oneClick ? { oneClick } : {}), ...(https ? { https } : {}), ...(mailto ? { mailto } : {}) }
}

/** A visible unsubscribe link is a page to open, never a background POST. */
export function findUnsubscribeLink(html: string, text = ''): string | undefined {
  const scan = (html || '').slice(0, 32_768) + (html.length > 32_768 ? html.slice(-32_768) : '')
  for (const match of scan.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']{1,2048})["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = httpsTarget(match[1]!.replaceAll('&amp;', '&'))
    if (!href) continue
    if (/(?:[/=?&_-])unsubscribe(?:[/=?&#_-]|$)/i.test(href) || /^\s*(?:unsubscribe|unsubscribe here|manage (?:email |your )?preferences|opt out)\s*$/i.test(match[2]!.replace(/<[^>]*>/g, ' '))) return href
  }
  const plain = (text || '').slice(-32_768)
  for (const match of plain.matchAll(/https:\/\/\S{1,2048}(?:[/=?&_-])unsubscribe(?:[/=?&#_-]|\b)/gi)) {
    const href = httpsTarget(match[0])
    if (href) return href
  }
}

export type UnsubscribeDelivery = { status: number }

/** RFC 8058: one bounded POST, no credentials, no redirect following, no body retention. */
export async function postOneClick(target: string, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<UnsubscribeDelivery> {
  const url = httpsTarget(target)
  if (!url) throw new Error('The unsubscribe target is not a safe HTTPS URL.')
  await assertPublicHost(new URL(url).hostname)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html, */*' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal,
    credentials: 'omit',
  })
  try { await response.body?.cancel() } catch { /* Nothing is read from the sender's page. */ }
  return { status: response.status }
}

/** Reject targets that resolve anywhere on the local network. */
export async function assertPublicHost(hostname: string, resolve: typeof lookup = lookup): Promise<void> {
  if (privateHost(hostname)) throw new Error('The unsubscribe target is not a public address.')
  const literal = /^[\d.]+$/.test(hostname) || hostname.includes(':')
  const addresses = literal ? [{ address: hostname }] : await resolve(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error('The unsubscribe target is not a public address.')
}

export function privateHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value.endsWith('.localhost') || value === 'localhost.localdomain') return true
  // Only a literal can be classified without resolving it. A name is checked
  // against its resolved addresses when the request is about to be delivered.
  return /^[\d.]+$/.test(value) || value.includes(':') ? privateAddress(value) : false
}

export function privateAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
    if (mapped) return privateAddress(mapped[1]!)
    return /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|ff[0-9a-f]{2}):/.test(value) || value.startsWith('fec0:')
  }
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a, b, c] = octets as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113
}
