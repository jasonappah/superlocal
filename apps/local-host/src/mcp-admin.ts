import { parseArgs } from 'node:util'
import { loadLocalConfig } from './config'
import { createMcpGrants } from './mcp-auth'
import { openLocalRuntime } from './runtime'

const help = `Manage MCP grants for this Superlocal installation

bun --no-env-file apps/local-host/src/mcp-admin.ts <command> [options]

grant   --name "<label>" [--write] [--json]  Create a grant; the token is printed once.
list    [--json]                             List grants; tokens are never shown.
revoke  <id> [--json]                        Revoke a grant; access ends immediately.
help                                         Show this text.

The command operates on the configured instance (SUPERLOCAL_CONFIG / SUPERLOCAL_DATA_DIR).
Grant tokens equal superlocal_mcp_ plus 32 unpadded base64url characters.
`

function stamp(value: number | null): string {
  if (value === null) return 'never'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'never'
}

async function main() {
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    name: { type: 'string' }, write: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  const command = positionals[0]
  if (!command || values.help || command === 'help') { process.stdout.write(help); return }
  if (!['grant', 'list', 'revoke'].includes(command) || (command === 'revoke' ? positionals.length !== 2 : positionals.length !== 1)) {
    process.stdout.write(help)
    process.exitCode = 1
    return
  }
  const config = loadLocalConfig()
  const local = openLocalRuntime(config)
  try {
    // Grants bind to this installation's single owner; other owners are refused at creation.
    const grants = createMcpGrants(config, local)
    if (command === 'grant') {
      if (!values.name?.trim()) throw new Error('MCP_NAME_REQUIRED')
      const scope = values.write ? 'write' : 'read'
      const grant = grants.create(grants.owner, values.name, scope)
      const view = grants.list().find(entry => entry.id === grant.id)
      if (values.json) console.log(JSON.stringify({ ...(view ?? { id: grant.id, name: values.name.trim(), scope, createdAt: null, lastUsedAt: null, revokedAt: null }), token: grant.token }))
      else console.log(`MCP grant created: ${view?.name} (${scope}) ${grant.token}`)
      return
    }
    if (command === 'list') {
      const rows = grants.list()
      if (values.json) { console.log(JSON.stringify(rows)); return }
      for (const row of rows) {
        console.log(`${row.id}  ${row.name}  (${row.scope})  created ${stamp(row.createdAt)}  last used ${stamp(row.lastUsedAt)}${row.revokedAt === null ? '' : '  revoked'}`)
      }
      if (!rows.length) console.log('No MCP grants.')
      return
    }
    const id = positionals[1]!
    if (!grants.revoke(id)) throw new Error('MCP_GRANT_NOT_FOUND')
    if (values.json) console.log(JSON.stringify({ id, revoked: true }))
    else console.log(`MCP grant revoked: ${id}`)
  } finally { local.database.close() }
}

main().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message) ? error.message : 'MCP_ADMIN_FAILED'
  console.error(code)
  process.exitCode = 1
})
