import { randomBytes } from 'node:crypto'
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
      try { await service.close(); await lock.release() } catch { console.error('[LOCAL_SHUTDOWN_FAILED] Desktop host shutdown failed.'); process.exitCode = 1 }
    })()
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (error) { reportStartupError(error); process.exitCode = 1 }
}
