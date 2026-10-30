// Fictional, file-backed SDK probe. Compiled alongside the production worker;
// run from an empty directory without Bun or the source tree on PATH.
import { Database } from 'bun:sqlite'
import { createInbox } from '../../../packages/inbox-sdk/src/core'
import type { ProviderDefinition } from '../../../packages/inbox-sdk/src/contracts'

const NativeWorker = globalThis.Worker
let workerResults = 0
globalThis.Worker = class extends NativeWorker {
  constructor(...args: ConstructorParameters<typeof Worker>) {
    super(...args)
    this.addEventListener('error', event => console.error('fictional worker error:', event.message))
    this.addEventListener('message', event => {
      if (event.data?.type === 'error') console.error('fictional worker rejected read')
      if (event.data?.type === 'result') workerResults++
    })
  }
} as typeof Worker
const database = new Database('fictional.sqlite', { create: true })
const definition = {
  id: 'fictional', name: 'Fictional', connection: 'credentials',
  create: (credentials: Record<string, unknown>) => ({
    accountId: credentials.accountId as string,
    capabilities: { send: false },
    getAccount: async () => ({ id: credentials.accountId, email: 'owner@example.test', name: 'Fictional' }),
    disconnect: async () => {},
  }),
} as unknown as ProviderDefinition
const inbox = createInbox({ database, encryptionKey: '1'.repeat(64), providers: [definition] })
try {
  const account = await inbox.connect('owner', { providerId: 'fictional', credentials: {} })
  const result = await inbox.mailboxCorrespondence('owner', { mailboxIds: [account.id], email: 'sender@example.test',
    since: '2026-01-01T00:00:00Z', bucketMs: 3600000, bucketCount: 1 })
  if (result.received !== 0 || result.sent !== 0 || result.conversations !== 0 || workerResults !== 1) throw new Error('Unexpected correspondence result or worker count')
  console.log('standalone SDK correspondence passed')
} finally {
  await inbox.close()
  database.close()
}
