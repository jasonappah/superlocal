import { mkdir, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Build the macOS app: compiled host sidecar, built web UI, Tauri bundle.
 *
 *   bun --no-env-file scripts/build-desktop.ts            # build the .app
 *   bun --no-env-file scripts/build-desktop.ts --install  # build and install to /Applications
 *   bun --no-env-file scripts/build-desktop.ts --install --adopt <config.json>
 *
 * `--adopt` records a private pointer so Finder launches open an existing
 * Superlocal profile in place instead of creating a fresh one. Nothing is
 * copied, migrated or reset: the app validates and then uses the paths named
 * by that configuration.
 */
const root = resolve(import.meta.dir, '..')
const tauri = join(root, 'apps/desktop/src-tauri')
const resources = join(tauri, 'resources')
const APP_NAME = 'Superlocal'
const CONFIG_DIR = join(process.env.HOME ?? '', 'Library/Application Support/ceo.ryan.superlocal')
if (process.platform !== 'darwin') throw new Error('Desktop packaging is currently limited to macOS.')

const args = process.argv.slice(2)
const sidecarOnly = args.includes('--sidecar-only')
const install = args.includes('--install')
const adoptAt = args.indexOf('--adopt')
const adopt = adoptAt >= 0 ? args[adoptAt + 1] : undefined
if (adoptAt >= 0 && !adopt) throw new Error('--adopt requires the path of an existing Superlocal config.json')
const known = new Set(['--sidecar-only', '--install', '--adopt'])
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--adopt') { index++; continue }
  if (!known.has(args[index]!)) throw new Error(`Unknown option: ${args[index]}`)
}
if (adopt && !install) throw new Error('--adopt is only used together with --install')

async function run(command: string[], cwd = root) {
  const result = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, PATH: `${join(root, 'data/desktop-tools/bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, BUN_NO_ENV_FILE: '1' } })
  if (await result.exited !== 0) throw new Error(`Desktop build failed: ${command[0]}`)
}

await mkdir(resources, { recursive: true })
const host = join(resources, 'superlocal-host')
await run(['bun', '--no-env-file', 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--define', '__SUPERLOCAL_STANDALONE__=true',
  'apps/local-host/src/index.ts', 'packages/inbox-sdk/src/correspondence-worker.ts', '--outfile', host])
// Bun 1.4's compile output needs a fresh ad-hoc signature on macOS, otherwise the
// kernel kills it before main. This is local execution only, not notarization.
await run(['codesign', '--force', '--sign', '-', host])
await run(['codesign', '--verify', '--strict', host])
if (sidecarOnly) {
  console.info('Sidecar built and signed.')
  process.exit(0)
}
await run(['bun', '--no-env-file', 'run', '--cwd', 'apps/web', 'build'])
await cp(join(root, 'apps/web/dist'), join(resources, 'web'), { recursive: true })
await run(['cargo', 'tauri', 'build', '--bundles', 'app'], tauri)
const bundle = join(tauri, 'target/release/bundle/macos', `${APP_NAME}.app`)
await run(['codesign', '--force', '--sign', '-', bundle])
await run(['codesign', '--verify', '--strict', bundle])
console.info(`Built ${bundle}`)

if (!install) process.exit(0)

// Install: replace only our own bundle, then record the optional profile choice.
const target = join('/Applications', `${APP_NAME}.app`)
const existing = await Bun.file(join(target, 'Contents/Info.plist')).exists()
if (existing) await run(['rm', '-rf', target])
await run(['ditto', bundle, target])
await run(['codesign', '--force', '--sign', '-', target])
await run(['codesign', '--verify', '--strict', target])
await run(['xattr', '-dr', 'com.apple.quarantine', target]).catch(() => {})

if (adopt) {
  const absolute = resolve(adopt)
  const file = Bun.file(absolute)
  if (!(await file.exists())) throw new Error(`Existing configuration not found: ${absolute}`)
  const stat = await import('node:fs/promises').then(fs => fs.stat(absolute))
  if ((stat.mode & 0o077) !== 0 || !stat.isFile()) throw new Error('Existing configuration must be a private owner-only regular file')
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const fs = await import('node:fs/promises')
  const pointer = join(CONFIG_DIR, 'existing-config')
  await fs.writeFile(pointer, `${absolute}\n`, { mode: 0o600 })
  await fs.chmod(pointer, 0o600)
  console.info(`Adopting existing profile: ${absolute}`)
}
console.info(`Installed ${target}`)
