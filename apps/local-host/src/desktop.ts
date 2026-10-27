import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadLocalConfig, LocalConfigurationError, ROOT_DIR, type LocalConfig } from './config'
import { reportStartupError, startLocalServer } from './index'

export function createDesktopBootstrap(): string {
  return randomBytes(32).toString('base64url')
}

/** Exclusive per-profile coordination: a second desktop host with a live owner may not open the same mail data. */
export function acquireInstanceLock(config: LocalConfig): { release(): Promise<void> } {
  const path = join(config.dataDir, config.mode, 'instance.lock')
  mkdirSync(join(config.dataDir, config.mode), { recursive: true, mode: 0o700 })
  const alive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) return false
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  const readLock = (): { pid?: unknown } => {
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 1024 || process.platform !== 'win32' &&
        ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())) throw new Error('permissions')
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))) as { pid?: unknown } } catch { return {} }
    } catch (error) {
      throw new LocalConfigurationError('LOCAL_FILE_PERMISSIONS', 'The instance lock must be an owner-only regular file (chmod 600 on Unix), never a symlink. Existing files were not replaced.')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  let holder: number | undefined
  for (let attempt = 0; attempt < 3 && holder === undefined; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_SYNC, 0o600)
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
      holder = process.pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LocalConfigurationError('LOCAL_FILE_CREATE_FAILED', 'Could not create the owner-only instance lock. Existing files were not replaced.')
      }
      const saved = readLock()
      if (typeof saved.pid === 'number' && alive(saved.pid)) {
        throw new LocalConfigurationError('LOCAL_INSTANCE_BUSY', 'This Superlocal profile is already served by another local host process. Close it before starting the desktop host.')
      }
      try { unlinkSync(path) } catch {}
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  if (holder === undefined) {
    throw new LocalConfigurationError('LOCAL_INSTANCE_BUSY', 'This Superlocal profile is already served by another local host process. Close it before starting the desktop host.')
  }
  holder = process.pid
  return {
    async release() {
      if (holder !== process.pid) { holder = undefined; return }
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) return
        if (readLock().pid === process.pid) unlinkSync(path)
      } catch {} finally { holder = undefined }
    },
  }
}

/** Build identity is environment-only progress reporting: a bounded label, never a credential. */
function buildIdentity(environment: NodeJS.ProcessEnv): string {
  const id = environment.SUPERLOCAL_BUILD_ID
  return typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : 'dev'
}

/** Private readiness handoff for the packaged shell: the actual API port, build and one-time bootstrap token. */
export function writeDesktopReadiness(config: LocalConfig, port: number, environment: NodeJS.ProcessEnv = process.env): void {
  const value = { version: 1, apiPort: port, build: buildIdentity(environment), instanceId: config.instanceId, mode: config.mode,
    bootstrapToken: config.desktopBootstrapToken }
  const path = join(config.dataDir, 'desktop-readiness.json')
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const temp = join(config.dataDir, `.desktop-readiness-${randomBytes(12).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    let existing: import('node:fs').Stats | undefined
    try { existing = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing?.isSymbolicLink()) throw new LocalConfigurationError('LOCAL_FILE_PERMISSIONS', 'The desktop readiness file must never be replaced through a symlink.')
    renameSync(temp, path)
  } catch (error) {
    if (error instanceof LocalConfigurationError) { try { unlinkSync(temp) } catch {}; throw error }
    try { unlinkSync(temp) } catch {}
    throw new LocalConfigurationError('LOCAL_FILE_CREATE_FAILED', 'Could not write the desktop readiness file. Existing files were not replaced.')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function deleteDesktopReadiness(config: LocalConfig): void {
  try { unlinkSync(join(config.dataDir, 'desktop-readiness.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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

/** Packaged entry: one loopback port serves the built UI and the API, with a private readiness file and instance lock. */
export async function runDesktopHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const base = loadLocalConfig({ environment })
    const assets = typeof environment.SUPERLOCAL_DESKTOP_ASSETS === 'string' && !environment.SUPERLOCAL_DESKTOP_ASSETS.includes('\0') &&
      environment.SUPERLOCAL_DESKTOP_ASSETS.length <= 1024 && isAbsolute(environment.SUPERLOCAL_DESKTOP_ASSETS)
      ? resolve(environment.SUPERLOCAL_DESKTOP_ASSETS) : join(ROOT_DIR, 'apps', 'web', 'dist')
    const port = base.backend.port
    const config: LocalConfig = { ...base,
      web: { port, origin: `http://localhost:${port}`, allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] },
      desktop: true, desktopAssets: assets, desktopBootstrapToken: createDesktopBootstrap() }
    const lock = acquireInstanceLock(config)
    let service: Awaited<ReturnType<typeof startLocalServer>>
    try { service = await startLocalServer(config) }
    catch (error) { await lock.release(); throw error }
    try { writeDesktopReadiness(config, service.server.port ?? config.backend.port, environment) }
    catch (error) { await service.close(); await lock.release(); throw error }
    console.info(`Desktop host ready (build ${buildIdentity(environment)}): http://127.0.0.1:${service.server.port}`)
    let stopping: Promise<void> | undefined
    const stop = () => stopping ??= (async () => {
      deleteDesktopReadiness(config)
      await lock.release()
      try { await service.close() } catch { console.error('[LOCAL_SHUTDOWN_FAILED] Desktop host shutdown failed.'); process.exitCode = 1 }
    })()
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (error) { reportStartupError(error); process.exitCode = 1 }
}
