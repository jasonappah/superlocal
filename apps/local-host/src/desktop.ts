import { randomBytes } from 'node:crypto'
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadLocalConfig, LocalConfigurationError, ROOT_DIR, type LocalConfig } from './config'
import { reportStartupError, startLocalServer } from './index'

export function createDesktopBootstrap(): string {
  return randomBytes(32).toString('base64url')
}

/** One bounded JSON line from the owning supervisor; the pipe remains open as a lease. */
export function readSupervisorBootstrap(input: NodeJS.ReadableStream, onDisconnect: () => void, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), complete = false, disconnected = false
    const fail = () => {
      if (disconnected) return
      disconnected = true
      clearTimeout(timer)
      if (complete) onDisconnect()
      else reject(new LocalConfigurationError('LOCAL_SUPERVISOR_CHANNEL', 'The supervisor channel closed or sent an invalid bootstrap.'))
    }
    const timer = setTimeout(fail, timeoutMs)
    input.on('data', (chunk: Buffer | string) => {
      if (disconnected) return
      if (complete) { fail(); return }
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      if (buffer.length > 512) { fail(); return }
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      if (newline !== buffer.length - 1) { fail(); return }
      try {
        const value = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'bootstrapToken,version' ||
          value.version !== 1 || typeof value.bootstrapToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.bootstrapToken)) { fail(); return }
        complete = true
        buffer = Buffer.alloc(0)
        clearTimeout(timer)
        resolve(value.bootstrapToken)
      } catch { fail() }
    })
    input.on('end', fail)
    input.on('error', fail)
    input.on('close', fail)
    input.resume()
  })
}

/** Exclusive per-profile coordination: a second desktop host with a live owner may not open the same mail data. */
export function acquireInstanceLock(config: LocalConfig): { release(): Promise<void> } {
  const path = join(config.dataDir, config.mode, 'instance.lock')
  mkdirSync(join(config.dataDir, config.mode), { recursive: true, mode: 0o700 })
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new LocalConfigurationError('LOCAL_LOCK_UNSUPPORTED', 'Desktop profile locking is unavailable on this platform.')
  const library = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
      throw new LocalConfigurationError('LOCAL_FILE_PERMISSIONS', 'The instance lock must be an owner-only regular file, never a symlink or hard link.')
    }
    // Keep the inode in place: unlinking a locked file would permit a second owner.
    if (library.symbols.flock(fd, 2 | 4) !== 0) throw new LocalConfigurationError('LOCAL_INSTANCE_BUSY', 'This Superlocal profile is already served by another local host process. Close it before starting the desktop host.')
    ftruncateSync(fd, 0)
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    library.close()
    if (error instanceof LocalConfigurationError) throw error
    throw new LocalConfigurationError('LOCAL_FILE_PERMISSIONS', 'The instance lock must be an owner-only regular file, never a symlink or hard link.')
  }
  let holder: number | undefined = fd
  return {
    async release() {
      if (holder === undefined) return
      closeSync(holder)
      holder = undefined
      library.close()
    },
  }
}

/** Build identity is environment-only progress reporting: a bounded label, never a credential. */
function buildIdentity(environment: NodeJS.ProcessEnv): string {
  const id = environment.SUPERLOCAL_BUILD_ID
  return typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : 'dev'
}

const assetCsp = 'default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; ' +
  'font-src \'self\'; connect-src \'self\'; media-src \'self\' data:; worker-src \'self\' blob:; frame-src \'self\' data:'
const assetMime = new Map([['js', 'text/javascript'], ['css', 'text/css'], ['woff2', 'font/woff2'], ['svg', 'image/svg+xml'],
  ['html', 'text/html'], ['json', 'application/json'], ['map', 'application/json']])

/** Safe static serving of the built UI: four exact URL shapes, no traversal, no symlink escape, containment-checked. */
export function staticAssetResponse(assetsDir: string, request: Request): Response | undefined {
  if (request.method !== 'GET') return undefined
  const raw = new URL(request.url).pathname
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { return undefined }
  if (decoded !== raw || raw.includes('\\') || raw.includes('\0')) return undefined
  let file: string | undefined
  let cache: string | undefined
  if (raw === '/') { file = 'index.html'; cache = 'no-store' }
  else if (raw === '/favicon.svg') { file = 'favicon.svg'; cache = 'max-age=3600' }
  else if (raw === '/fonts.css') { file = 'fonts.css'; cache = 'max-age=3600' }
  else {
    const token = /^\/assets\/([A-Za-z0-9_.-]{1,256})$/.exec(raw)?.[1]
    if (token && token !== '.' && token !== '..') { file = join('assets', token); cache = 'public, max-age=31536000, immutable' }
  }
  if (!file || cache === undefined) return undefined
  try {
    const root = realpathSync(assetsDir)
    const target = resolve(root, file)
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    // Even within the bounded token shape, a symlinked subdirectory must not widen the served root.
    const real = realpathSync(target)
    const inside = relative(root, real)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined
    const extension = target.split('.').pop()?.toLowerCase() ?? ''
    return new Response(readFileSync(real), { headers: {
      'Cache-Control': cache, 'Content-Type': `${assetMime.get(extension) ?? 'application/octet-stream'}${extension === 'html' ? '; charset=utf-8' : ''}`,
      'Content-Security-Policy': assetCsp, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } })
  } catch {
    return undefined
  }
}

/** Packaged entry: one loopback port, an inherited private channel and an instance lock. */
export async function runDesktopHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const supervised = environment.SUPERLOCAL_DESKTOP_SUPERVISED === '1'
  let disconnected = false
  let stop: (() => Promise<void>) | undefined
  // Startup is bounded even if host initialization stalls. The supervisor owns escalation after readiness.
  const startupDeadline = supervised ? setTimeout(() => { console.error('[LOCAL_START_TIMEOUT] Desktop host startup timed out.'); process.exit(1) }, 30_000) : undefined
  try {
    if (!supervised) throw new LocalConfigurationError('LOCAL_SUPERVISOR_REQUIRED', 'Desktop mode requires a supervisor channel.')
    const bootstrapToken = await readSupervisorBootstrap(process.stdin, () => {
      disconnected = true
      if (stop) void stop()
      else process.exit(1)
    })
    const base = loadLocalConfig({ environment })
    if (supervised && base.auth.method !== 'loopback') throw new LocalConfigurationError('LOCAL_DESKTOP_AUTH_UNSUPPORTED', 'Supervised desktop bootstrap requires loopback authentication.')
    const assets = typeof environment.SUPERLOCAL_DESKTOP_ASSETS === 'string' && !environment.SUPERLOCAL_DESKTOP_ASSETS.includes('\0') &&
      environment.SUPERLOCAL_DESKTOP_ASSETS.length <= 1024 && isAbsolute(environment.SUPERLOCAL_DESKTOP_ASSETS)
      ? resolve(environment.SUPERLOCAL_DESKTOP_ASSETS) : join(ROOT_DIR, 'apps', 'web', 'dist')
    const port = base.backend.port
    const config: LocalConfig = { ...base,
      web: { port, origin: `http://localhost:${port}`, allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] },
      desktop: true, desktopAssets: assets, desktopBootstrapToken: bootstrapToken }
    const lock = acquireInstanceLock(config)
    let service: Awaited<ReturnType<typeof startLocalServer>>
    try { service = await startLocalServer(config) }
    catch (error) { await lock.release(); throw error }
    try {
      if (supervised) {
        if (disconnected) throw new LocalConfigurationError('LOCAL_SUPERVISOR_CHANNEL', 'The supervisor channel closed during startup.')
        process.stdout.write(`${JSON.stringify({ version: 1, pid: process.pid, apiPort: service.server.port, build: buildIdentity(environment), instanceId: config.instanceId, mode: config.mode })}\n`)
      }
    }
    catch (error) { await service.close(); await lock.release(); throw error }
    if (startupDeadline) clearTimeout(startupDeadline)
    let stopping: Promise<void> | undefined
    stop = () => stopping ??= (async () => {
      const deadline = supervised ? setTimeout(() => { console.error('[LOCAL_SHUTDOWN_TIMEOUT] Desktop host shutdown timed out.'); process.exit(1) }, 10_000) : undefined
      try { await service.close(); await lock.release() } catch { console.error('[LOCAL_SHUTDOWN_FAILED] Desktop host shutdown failed.'); process.exitCode = 1 }
      finally { if (supervised) process.stdin.pause(); if (deadline) clearTimeout(deadline) }
    })()
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (error) { if (startupDeadline) clearTimeout(startupDeadline); reportStartupError(error); process.exitCode = 1; if (supervised) process.stdin.pause() }
}
