import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('This probe currently targets macOS.')
const root = resolve(import.meta.dir, '../../..')
const temporary = await mkdtemp(join(tmpdir(), 'superlocal-standalone-sdk-'))
const binary = join(temporary, 'sdk-probe')
async function run(command: string[], cwd: string, env: Record<string, string> = process.env as Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  const timer = setTimeout(() => child.kill(), 30_000)
  try { if (await child.exited !== 0) throw new Error(`Probe failed: ${command[0]}`) }
  finally { clearTimeout(timer) }
}
try {
  await run(['bun', '--no-env-file', 'build', '--compile', '--define', '__SUPERLOCAL_STANDALONE__=true',
    'apps/desktop/qa/standalone-sdk.ts', 'packages/inbox-sdk/src/correspondence-worker.ts', '--outfile', binary], root)
  await run(['codesign', '--force', '--sign', '-', binary], root)
  await run(['codesign', '--verify', '--strict', binary], root)
  await run([binary], temporary, { HOME: temporary, PATH: '/usr/bin:/bin' })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
